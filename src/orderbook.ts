import { ERROR, CustomError } from './errors'
import { Order, OrderType, TimeInForce } from './order'
import { OrderQueue } from './orderqueue'
import { OrderSide } from './orderside'
import { Side } from './side'
import type {
  DepthLevel,
  ICancelOrder,
  IProcessOrder,
  JournalLog,
  LimitOrderExtras,
  OrderBookOptions,
  OrderExtras,
  OrderUpdatePrice,
  OrderUpdateSize,
  Snapshot,
  Trade
} from './types'

const validTimeInForce = Object.values(TimeInForce)

interface Taker {
  id: string
  side: Side
  owner?: unknown
  meta?: unknown
}

export class OrderBook {
  private orders: { [key: string]: Order } = {}
  private _lastOp: number = 0
  private _seq: number = 0
  private _tradeCount: number = 0
  private _replaying: boolean = false // eslint-disable-line @typescript-eslint/prefer-readonly
  private readonly clock: () => number
  private readonly onTrade?: (trade: Trade) => void
  private readonly bids: OrderSide
  private readonly asks: OrderSide
  private readonly enableJournaling: boolean
  /**
   * Creates an instance of OrderBook.
   * @param {OrderBookOptions} [options={}] - Options for configuring the order book.
   * @param {JournalLog} [options.snapshot] - The orderbook snapshot will be restored before processing any journal logs, if any.
   * @param {JournalLog} [options.journal] - Array of journal logs (optional).
   * @param {boolean} [options.enableJournaling=false] - Flag to enable journaling. Default to false
   * @param {() => number} [options.clock=Date.now] - Time source used everywhere a timestamp is needed.
   * @param {(trade: Trade) => void} [options.onTrade] - Called for every execution.
   */
  constructor ({
    snapshot,
    journal,
    enableJournaling = false,
    clock = Date.now,
    onTrade
  }: OrderBookOptions = {}) {
    this.clock = clock
    this.onTrade = onTrade
    this.bids = new OrderSide(Side.BUY, clock)
    this.asks = new OrderSide(Side.SELL, clock)
    this.enableJournaling = enableJournaling
    // First restore from orderbook snapshot
    if (snapshot != null) {
      this.restoreSnapshot(snapshot)
    }
    // Than replay from journal log
    if (journal != null) {
      if (!Array.isArray(journal)) throw CustomError(ERROR.ErrJournalLog)
      // If a snapshot is available be sure to remove logs before the last restored operation
      if (snapshot != null && snapshot.lastOp > 0) {
        journal = journal.filter((log) => log.opId > snapshot.lastOp)
      }
      this._replaying = true
      try {
        this.replayJournal(journal)
      } finally {
        this._replaying = false
      }
    }
  }

  /** Monotonic per-book sequence number of the latest operation or trade. */
  get seq (): number {
    return this._seq
  }

  // Getter for the lastOp
  get lastOp (): number {
    return this._lastOp
  }

  /**
   *  Create a trade order
   *  @see {@link IProcessOrder} for the returned data structure
   *
   *  @param type - `limit` or `market`
   *  @param side - `sell` or `buy`
   *  @param size - How much of currency you want to trade in units of base currency
   *  @param price - The price at which the order is to be fullfilled, in units of the quote currency. Param only for limit order
   *  @param orderID - Unique order ID. Required for limit orders, optional for market orders (generated if absent)
   *  @param timeInForce - Time-in-force supported are: `GTC` (default), `FOK`, `IOC`. Param only for limit order
   *  @param extras - Optional `owner`, `meta` and (limit only) `postOnly`
   *  @returns An object with the result of the processed order or an error.
   */
  public createOrder = (
    // Common for all order types
    type: OrderType,
    side: Side,
    size: number,
    // Specific for limit order type
    price?: number,
    orderID?: string,
    timeInForce: TimeInForce = TimeInForce.GTC,
    // `postOnly` applies to limit orders only
    extras: LimitOrderExtras = {}
  ): IProcessOrder => {
    switch (type) {
      case OrderType.MARKET:
        return this.market(side, size, orderID, extras)
      case OrderType.LIMIT:
        return this.limit(
          side,
          orderID as string,
          size,
          price as number,
          timeInForce,
          extras
        )
      default: {
        const response = this.getProcessOrderResponse(size)
        response.err = CustomError(ERROR.ErrInvalidOrderType)
        return response
      }
    }
  }

  /**
   * Create a market order
   *  @see {@link IProcessOrder} for the returned data structure
   *
   * @param side - `sell` or `buy`
   * @param size - How much of currency you want to trade in units of base currency
   * @param orderID - Optional caller supplied order ID (generated if absent), reported as `takerOrderId` in trades
   * @param extras - Optional opaque `owner` and `meta`
   * @returns An object with the result of the processed order or an error
   */
  public market = (
    side: Side,
    size: number,
    orderID?: string,
    extras: OrderExtras = {}
  ): IProcessOrder => {
    let quantityToTrade = size
    const response = this.getProcessOrderResponse(quantityToTrade)

    if (![Side.SELL, Side.BUY].includes(side)) {
      response.err = CustomError(ERROR.ErrInvalidSide)
      return response
    }

    if (typeof quantityToTrade !== 'number' || quantityToTrade <= 0) {
      response.err = CustomError(ERROR.ErrInsufficientQuantity)
      return response
    }

    if (orderID !== undefined && this.orders[orderID] !== undefined) {
      response.err = CustomError(ERROR.ErrOrderExists)
      return response
    }

    const now = this.clock()
    response.seq = this.nextSeq()
    const takerId = orderID ?? `mkt-${response.seq}`
    const taker: Taker = {
      id: takerId,
      side,
      owner: extras.owner,
      meta: extras.meta
    }

    let iter
    let sideToProcess: OrderSide
    if (side === Side.BUY) {
      iter = this.asks.minPriceQueue
      sideToProcess = this.asks
    } else {
      iter = this.bids.maxPriceQueue
      sideToProcess = this.bids
    }

    while (quantityToTrade > 0 && sideToProcess.len() > 0) {
      // if sideToProcess.len > 0 it is not necessary to verify that bestPrice exists
      const bestPrice = iter()
      const { done, partial, partialQuantityProcessed, quantityLeft } =
        this.processQueue(
          bestPrice as OrderQueue,
          quantityToTrade,
          taker,
          response.trades,
          now
        )
      response.done = response.done.concat(done)
      response.partial = partial
      response.partialQuantityProcessed = partialQuantityProcessed
      quantityToTrade = quantityLeft
    }
    response.quantityLeft = quantityToTrade
    if (this.enableJournaling) {
      response.log = {
        opId: ++this._lastOp,
        ts: now,
        op: 'm',
        o: this.defined({
          side,
          size,
          orderID,
          owner: extras.owner,
          meta: extras.meta
        })
      }
    }
    this.emitTrades(response.trades)
    return response
  }

  /**
   * Create a limit order
   *  @see {@link IProcessOrder} for the returned data structure
   *
   * @param side - `sell` or `buy`
   * @param orderID - Unique order ID
   * @param size - How much of currency you want to trade in units of base currency
   * @param price - The price at which the order is to be fullfilled, in units of the quote currency
   * @param timeInForce - Time-in-force type supported are: GTC, FOK, IOC
   * @param extras - Optional `owner`, `meta` and `postOnly` (reject instead of matching)
   * @returns An object with the result of the processed order or an error
   */
  public limit = (
    side: Side,
    orderID: string,
    size: number,
    price: number,
    timeInForce: TimeInForce = TimeInForce.GTC,
    extras: LimitOrderExtras = {}
  ): IProcessOrder => {
    const response = this.getProcessOrderResponse(size)

    if (![Side.SELL, Side.BUY].includes(side)) {
      response.err = CustomError(ERROR.ErrInvalidSide)
      return response
    }

    if (this.orders[orderID] !== undefined) {
      response.err = CustomError(ERROR.ErrOrderExists)
      return response
    }

    if (typeof size !== 'number' || size <= 0) {
      response.err = CustomError(ERROR.ErrInvalidQuantity)
      return response
    }

    if (typeof price !== 'number' || price <= 0) {
      response.err = CustomError(ERROR.ErrInvalidPrice)
      return response
    }

    if (!validTimeInForce.includes(timeInForce)) {
      response.err = CustomError(ERROR.ErrInvalidTimeInForce)
      return response
    }

    if (extras.postOnly === true && this.wouldCross(side, price)) {
      response.err = CustomError(ERROR.ErrPostOnlyWouldCross)
      return response
    }

    const now = this.clock()
    response.seq = this.nextSeq()
    this.createLimitOrder(
      response,
      side,
      orderID,
      size,
      price,
      timeInForce,
      now,
      extras.owner,
      extras.meta
    )
    if (this.enableJournaling) {
      response.log = {
        opId: ++this._lastOp,
        ts: now,
        op: 'l',
        o: this.defined({
          side,
          orderID,
          size,
          price,
          timeInForce,
          postOnly: extras.postOnly,
          owner: extras.owner,
          meta: extras.meta
        })
      }
    }
    this.emitTrades(response.trades)

    return response
  }

  /**
   * Modify an existing order with given ID. When an order is modified by price or quantity,
   * it will be deemed as a new entry. Under the price-time-priority algorithm, orders are
   * prioritized according to their order price and order time. Hence, the latest orders
   * will be placed at the back of the matching order queue.
   *
   * @param orderID - The ID of the order to be modified
   * @param orderUpdate - An object with the modified size and/or price of an order. The shape of the object is `{size, price}`.
   * @returns An object with the result of the processed order or an error
   */
  public modify = (
    orderID: string,
    orderUpdate: OrderUpdatePrice | OrderUpdateSize
  ): IProcessOrder => {
    const order = this.orders[orderID]
    if (order === undefined) {
      const response = this.getProcessOrderResponse(0)
      response.err = CustomError(ERROR.ErrOrderNotFound)
      return response
    }
    if (orderUpdate?.price !== undefined || orderUpdate?.size !== undefined) {
      const newPrice = orderUpdate.price ?? order.price
      const newSize = orderUpdate.size ?? order.size
      if (newPrice > 0 && newSize > 0) {
        const response = this.getProcessOrderResponse(newSize)
        const now = this.clock()
        response.seq = this.nextSeq()
        this._cancelOrder(order.id, true)
        this.createLimitOrder(
          response,
          order.side,
          order.id,
          newSize,
          newPrice,
          TimeInForce.GTC,
          now,
          order.owner,
          order.meta
        )
        if (this.enableJournaling) {
          response.log = {
            opId: ++this._lastOp,
            ts: now,
            op: 'u',
            o: { orderID, orderUpdate }
          }
        }
        this.emitTrades(response.trades)
        return response
      }
    }
    // Missing one of price and/or size, or the provided ones are not greater than zero
    const response = this.getProcessOrderResponse(orderUpdate?.size ?? 0)
    response.err = CustomError(ERROR.ErrInvalidPriceOrQuantity)
    return response
  }

  /**
   * Remove an existing order with given ID from the order book
   *
   * @param orderID - The ID of the order to be removed
   * @returns The removed order if exists or `undefined`
   */
  public cancel = (orderID: string): ICancelOrder | undefined => {
    return this._cancelOrder(orderID)
  }

  /**
   * Get an existing order with the given ID
   *
   * @param orderID - The ID of the order to be returned
   * @returns The order if exists or `undefined`
   */
  public order = (orderID: string): Order | undefined => {
    return this.orders[orderID]
  }

  /**
   * Returns `[price, size]` levels for asks (ascending) and bids (descending), best first.
   *
   * @param levels - Optional maximum number of levels returned per side
   */
  public depth = (
    levels?: number
  ): [Array<[number, number]>, Array<[number, number]>] => {
    const asks: Array<[number, number]> = []
    const bids: Array<[number, number]> = []
    this.collectLevels(this.asks, levels, (price, queue) => {
      asks.push([price, queue.volume()])
    })
    this.collectLevels(this.bids, levels, (price, queue) => {
      bids.push([price, queue.volume()])
    })
    return [asks, bids]
  }

  /**
   * Like {@link depth} but each level is `{ price, size, count }`, where `count`
   * is the number of resting orders at the level.
   */
  public depthDetailed = (levels?: number): [DepthLevel[], DepthLevel[]] => {
    const asks: DepthLevel[] = []
    const bids: DepthLevel[] = []
    this.collectLevels(this.asks, levels, (price, queue) => {
      asks.push({ price, size: queue.volume(), count: queue.len() })
    })
    this.collectLevels(this.bids, levels, (price, queue) => {
      bids.push({ price, size: queue.volume(), count: queue.len() })
    })
    return [asks, bids]
  }

  private readonly collectLevels = (
    side: OrderSide,
    levels: number | undefined,
    cb: (price: number, queue: OrderQueue) => void
  ): void => {
    if (levels !== undefined && !(levels > 0)) return
    let n = 0
    side.priceTree().forEach((price: number, queue: OrderQueue) => {
      cb(price, queue)
      n++
      if (levels !== undefined && n >= levels) return true
    })
  }

  public toString = (): string => {
    return (
      this.asks.toString() +
      '\r\n------------------------------------' +
      this.bids.toString()
    )
  }

  // Returns total market price for requested quantity
  // if err is not null price returns total price of all levels in side
  public calculateMarketPrice = (
    side: Side,
    size: number
  ): {
    price: number
    err: null | Error
  } => {
    let price = 0
    let err = null
    let level: OrderQueue | undefined
    let iter: (price: number) => OrderQueue | undefined

    if (side === Side.BUY) {
      level = this.asks.minPriceQueue()
      iter = this.asks.greaterThan
    } else {
      level = this.bids.maxPriceQueue()
      iter = this.bids.lowerThan
    }

    while (size > 0 && level !== undefined) {
      const levelVolume = level.volume()
      const levelPrice = level.price()
      if (this.greaterThanOrEqual(size, levelVolume)) {
        price += levelPrice * levelVolume
        size -= levelVolume
        level = iter(levelPrice)
      } else {
        price += levelPrice * size
        size = 0
      }
    }

    if (size > 0) {
      err = CustomError(ERROR.ErrInsufficientQuantity)
    }

    return { price, err }
  }

  public snapshot = (): Snapshot => {
    const bids: Array<{ price: number, orders: Order[] }> = []
    const asks: Array<{ price: number, orders: Order[] }> = []
    this.bids.priceTree().forEach((price: number, orders: OrderQueue) => {
      bids.push({ price, orders: orders.toArray() })
    })
    this.asks.priceTree().forEach((price: number, orders: OrderQueue) => {
      asks.push({ price, orders: orders.toArray() })
    })
    return { bids, asks, ts: this.clock(), lastOp: this._lastOp, seq: this._seq }
  }

  private readonly restoreSnapshot = (snapshot: Snapshot): void => {
    this._lastOp = snapshot.lastOp
    this._seq = snapshot.seq ?? 0
    for (const level of snapshot.bids) {
      for (const order of level.orders) {
        this.orders[order.id] = order
        this.bids.append(order)
      }
    }

    for (const level of snapshot.asks) {
      for (const order of level.orders) {
        this.orders[order.id] = order
        this.asks.append(order)
      }
    }
  }

  private readonly _cancelOrder = (
    orderID: string,
    skipOpInc: boolean = false
  ): ICancelOrder | undefined => {
    const order = this.orders[orderID]
    if (order === undefined) return
    /* eslint-disable @typescript-eslint/no-dynamic-delete */
    delete this.orders[orderID]
    if (order.side === Side.BUY) {
      const response: ICancelOrder = {
        order: this.bids.remove(order)
      }
      if (this.enableJournaling) {
        response.log = {
          opId: skipOpInc ? this._lastOp : ++this._lastOp,
          ts: this.clock(),
          op: 'd',
          o: { orderID }
        }
      }
      return response
    }

    // Side SELL
    const response: ICancelOrder = {
      order: this.asks.remove(order)
    }
    if (this.enableJournaling) {
      response.log = {
        opId: skipOpInc ? this._lastOp : ++this._lastOp,
        ts: this.clock(),
        op: 'd',
        o: { orderID }
      }
    }
    return response
  }

  // Drops undefined keys so journal entries stay minimal
  private readonly defined = <T extends object>(o: T): T => {
    for (const k of Object.keys(o)) {
      if ((o as Record<string, unknown>)[k] === undefined) {
        /* eslint-disable @typescript-eslint/no-dynamic-delete */
        delete (o as Record<string, unknown>)[k]
      }
    }
    return o
  }

  private readonly nextSeq = (): number => ++this._seq

  private readonly getProcessOrderResponse = (size: number): IProcessOrder => {
    return {
      done: [],
      partial: null,
      partialQuantityProcessed: 0,
      quantityLeft: size,
      err: null,
      trades: [],
      seq: this._seq
    }
  }

  private readonly emitTrades = (trades: Trade[]): void => {
    if (this.onTrade === undefined || this._replaying) return
    for (const trade of trades) this.onTrade(trade)
  }

  private readonly wouldCross = (side: Side, price: number): boolean => {
    if (side === Side.BUY) {
      const best = this.asks.minPriceQueue()
      return best !== undefined && price >= best.price()
    }
    const best = this.bids.maxPriceQueue()
    return best !== undefined && price <= best.price()
  }

  private readonly createLimitOrder = (
    response: IProcessOrder,
    side: Side,
    orderID: string,
    size: number,
    price: number,
    timeInForce: TimeInForce,
    now: number,
    owner?: unknown,
    meta?: unknown
  ): void => {
    const taker: Taker = { id: orderID, side, owner, meta }
    let quantityToTrade = size
    let sideToProcess: OrderSide
    let sideToAdd: OrderSide
    let comparator
    let iter

    if (side === Side.BUY) {
      sideToAdd = this.bids
      sideToProcess = this.asks
      comparator = this.greaterThanOrEqual
      iter = this.asks.minPriceQueue
    } else {
      sideToAdd = this.asks
      sideToProcess = this.bids
      comparator = this.lowerThanOrEqual
      iter = this.bids.maxPriceQueue
    }

    if (timeInForce === TimeInForce.FOK) {
      const fillable = this.canFillOrder(sideToProcess, side, size, price)
      if (!fillable) {
        response.err = CustomError(ERROR.ErrLimitFOKNotFillable)
        return
      }
    }

    let bestPrice = iter()
    while (
      quantityToTrade > 0 &&
      sideToProcess.len() > 0 &&
      bestPrice !== undefined &&
      comparator(price, bestPrice.price())
    ) {
      const { done, partial, partialQuantityProcessed, quantityLeft } =
        this.processQueue(
          bestPrice,
          quantityToTrade,
          taker,
          response.trades,
          now
        )
      response.done = response.done.concat(done)
      response.partial = partial
      response.partialQuantityProcessed = partialQuantityProcessed
      quantityToTrade = quantityLeft
      response.quantityLeft = quantityToTrade
      bestPrice = iter()
    }

    if (quantityToTrade > 0) {
      const order = new Order(
        orderID,
        side,
        quantityToTrade,
        price,
        now,
        true,
        undefined,
        owner,
        meta
      )
      if (response.done.length > 0) {
        response.partialQuantityProcessed = size - quantityToTrade
        response.partial = order
      }
      this.orders[orderID] = sideToAdd.append(order)
    } else {
      let totalQuantity = 0
      let totalPrice = 0

      response.done.forEach((order: Order) => {
        totalQuantity += order.size
        totalPrice += order.price * order.size
      })

      if (response.partialQuantityProcessed > 0 && response.partial !== null) {
        totalQuantity += response.partialQuantityProcessed
        totalPrice +=
          response.partial.price * response.partialQuantityProcessed
      }

      response.done.push(
        new Order(
          orderID,
          side,
          size,
          totalPrice / totalQuantity,
          now,
          false,
          undefined,
          owner,
          meta
        )
      )
    }

    // If IOC order was not matched completely remove from the order book
    if (timeInForce === TimeInForce.IOC && response.quantityLeft > 0) {
      this._cancelOrder(orderID, true)
    }
  }

  private readonly replayJournal = (journal: JournalLog[]): void => {
    for (const log of journal) {
      switch (log.op) {
        case 'm':
          if (log.o.side == null || log.o.size == null) {
            throw CustomError(ERROR.ErrJournalLog)
          }
          this.market(log.o.side, log.o.size, log.o.orderID, {
            owner: log.o.owner,
            meta: log.o.meta
          })
          break
        case 'l':
          if (
            log.o.side == null ||
            log.o.orderID == null ||
            log.o.size == null ||
            log.o.price == null
          ) {
            throw CustomError(ERROR.ErrJournalLog)
          }
          this.limit(
            log.o.side,
            log.o.orderID,
            log.o.size,
            log.o.price,
            log.o.timeInForce,
            {
              postOnly: log.o.postOnly,
              owner: log.o.owner,
              meta: log.o.meta
            }
          )
          break
        case 'd':
          if (log.o.orderID == null) throw CustomError(ERROR.ErrJournalLog)
          this.cancel(log.o.orderID)
          break
        case 'u':
          if (log.o.orderID == null || log.o.orderUpdate == null) {
            throw CustomError(ERROR.ErrJournalLog)
          }
          this.modify(log.o.orderID, log.o.orderUpdate)
          break
        default:
          throw CustomError(ERROR.ErrJournalLog)
      }
    }
  }

  private readonly greaterThanOrEqual = (a: number, b: number): boolean => {
    return a >= b
  }

  private readonly lowerThanOrEqual = (a: number, b: number): boolean => {
    return a <= b
  }

  private readonly processQueue = (
    orderQueue: OrderQueue,
    quantityToTrade: number,
    taker: Taker,
    trades: Trade[],
    now: number
  ): IProcessOrder => {
    const response = this.getProcessOrderResponse(quantityToTrade)
    const record = (maker: Order, size: number): void => {
      const seq = this.nextSeq()
      const trade: Trade = {
        tradeId: `t${++this._tradeCount}`,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        side: taker.side,
        price: maker.price,
        size,
        timestamp: now,
        seq
      }
      if (maker.owner !== undefined) trade.makerOwner = maker.owner
      if (taker.owner !== undefined) trade.takerOwner = taker.owner
      if (maker.meta !== undefined) trade.makerMeta = maker.meta
      if (taker.meta !== undefined) trade.takerMeta = taker.meta
      trades.push(trade)
    }
    if (response.quantityLeft > 0) {
      while (orderQueue.len() > 0 && response.quantityLeft > 0) {
        const headOrder = orderQueue.head()
        if (headOrder !== undefined) {
          if (response.quantityLeft < headOrder.size) {
            record(headOrder, response.quantityLeft)
            response.partial = new Order(
              headOrder.id,
              headOrder.side,
              headOrder.size - response.quantityLeft,
              headOrder.price,
              headOrder.time,
              true,
              headOrder.origSize,
              headOrder.owner,
              headOrder.meta
            )
            this.orders[headOrder.id] = response.partial
            response.partialQuantityProcessed = response.quantityLeft
            orderQueue.update(headOrder, response.partial)
            response.quantityLeft = 0
          } else {
            record(headOrder, headOrder.size)
            response.quantityLeft = response.quantityLeft - headOrder.size
            const canceledOrder = this._cancelOrder(headOrder.id, true)
            /* c8 ignore next unable to test when order is undefined */
            if (canceledOrder?.order !== undefined) {
              response.done.push(canceledOrder.order)
            }
          }
        }
      }
    }
    return response
  }

  private readonly canFillOrder = (
    orderSide: OrderSide,
    side: Side,
    size: number,
    price: number
  ): boolean => {
    return side === Side.BUY
      ? this.buyOrderCanBeFilled(orderSide, size, price)
      : this.sellOrderCanBeFilled(orderSide, size, price)
  }

  private readonly buyOrderCanBeFilled = (
    orderSide: OrderSide,
    size: number,
    price: number
  ): boolean => {
    if (orderSide.volume() < size) {
      return false
    }

    let cumulativeSize = 0
    orderSide.priceTree().forEach((_: number, level: OrderQueue) => {
      if (price >= level.price() && cumulativeSize < size) {
        cumulativeSize += level.volume()
      } else {
        return true // break the loop
      }
    })
    return cumulativeSize >= size
  }

  private readonly sellOrderCanBeFilled = (
    orderSide: OrderSide,
    size: number,
    price: number
  ): boolean => {
    if (orderSide.volume() < size) {
      return false
    }

    let cumulativeSize = 0
    orderSide.priceTree().forEach((_: number, level: OrderQueue) => {
      if (price <= level.price() && cumulativeSize < size) {
        cumulativeSize += level.volume()
      } else {
        return true // break the loop
      }
    })
    return cumulativeSize >= size
  }
}
