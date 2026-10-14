/* node:coverage disable */
import type { OrderBookError } from "./errors";
import type { LimitOrder, StopLimitOrder, StopMarketOrder } from "./order";
export enum Side {
	BUY = "buy",
	SELL = "sell",
}

export enum SelfTradePreventionMode {
	NONE = "NONE",
	EXPIRE_TAKER = "EXPIRE_TAKER",
	EXPIRE_MAKER = "EXPIRE_MAKER",
	EXPIRE_BOTH = "EXPIRE_BOTH",
}

export enum OrderType {
	LIMIT = "limit",
	MARKET = "market",
	OCO = "oco",
	STOP_LIMIT = "stop_limit",
	STOP_MARKET = "stop_market",
}

export enum TimeInForce {
	GTC = "GTC",
	IOC = "IOC",
	FOK = "FOK",
}

export interface IError {
	code: number;
	message: string;
}

export type StopOrder = StopLimitOrder | StopMarketOrder;
export type Order = LimitOrder | StopOrder;

interface BaseOrderOptions {
	id?: string;
	side: Side;
	size: number;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
	/** Opaque value carried to the stored order, snapshots and trade records */
	owner?: unknown;
	/** Opaque value carried to the stored order, snapshots and trade records */
	meta?: unknown;
}
interface InternalBaseOrderOptions extends BaseOrderOptions {
	type: OrderType;
	time?: number;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
}
/**
 * Specific options for a market order.
 */
export interface MarketOrderOptions extends BaseOrderOptions {}
interface IMarketOrderOptions extends InternalBaseOrderOptions {}
export interface InternalMarketOrderOptions extends IMarketOrderOptions {
	type: OrderType.MARKET;
}

/**
 * Specific options for a limit order.
 */
export interface LimitOrderOptions extends MarketOrderOptions {
	id: string;
	price: number;
	timeInForce?: TimeInForce;
	postOnly?: boolean;
}
interface ILimitOrderOptions extends InternalBaseOrderOptions {
	id: string;
	price: number;
	timeInForce: TimeInForce;
}
export interface InternalLimitOrderOptions extends ILimitOrderOptions {
	type: OrderType.LIMIT;
	origSize: number;
	makerQty: number;
	takerQty: number;
	postOnly?: boolean;
	ocoStopPrice?: number;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
}

/**
 * Specific options for a stop market order.
 */
export interface StopMarketOrderOptions extends MarketOrderOptions {
	stopPrice: number;
}
export interface InternalStopMarketOrderOptions extends IMarketOrderOptions {
	type: OrderType.STOP_MARKET;
	stopPrice: number;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
}

/**
 * Specific options for a stop limit order.
 */
export interface StopLimitOrderOptions extends LimitOrderOptions {
	stopPrice: number;
}
export interface InternalStopLimitOrderOptions extends ILimitOrderOptions {
	type: OrderType.STOP_LIMIT;
	stopPrice: number;
	isOCO?: boolean;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
}

/**
 * Specific options for oco order.
 */
export interface OCOOrderOptions extends StopLimitOrderOptions {
	stopLimitPrice: number;
	stopLimitTimeInForce?: TimeInForce;
}

/**
 * Object object representation of a market order returned by the toObject() method.
 */
export interface IMarketOrder {
	id: string;
	type: OrderType;
	side: Side;
	size: number;
	origSize: number;
	time: number;
	owner?: unknown;
	meta?: unknown;
}

/**
 * Object object representation of a limit order returned by the toObject() method.
 */
export interface ILimitOrder {
	id: string;
	type: OrderType.LIMIT;
	side: Side;
	size: number;
	origSize: number;
	price: number;
	time: number;
	timeInForce: TimeInForce;
	takerQty: number;
	makerQty: number;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
	owner?: unknown;
	meta?: unknown;
}

/**
 * Object object representation of a stop market order returned by the toObject() method.
 */
export interface IStopMarketOrder {
	id: string;
	type: OrderType;
	side: Side;
	size: number;
	stopPrice: number;
	time: number;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
	owner?: unknown;
	meta?: unknown;
}

/**
 * Object object representation of a stop limit order returned by the toObject() method.
 */
export interface IStopLimitOrder {
	id: string;
	type: OrderType;
	side: Side;
	size: number;
	price: number;
	stopPrice: number;
	timeInForce: TimeInForce;
	time: number;
	isOCO: boolean;
	accountId?: string;
	stpMode?: SelfTradePreventionMode;
	owner?: unknown;
	meta?: unknown;
}

/**
 * Represents an order in the order book.
 */
export type OrderOptions =
	| InternalMarketOrderOptions
	| InternalLimitOrderOptions
	| InternalStopLimitOrderOptions
	| InternalStopMarketOrderOptions;

export type StopOrderOptions =
	| StopMarketOrderOptions
	| StopLimitOrderOptions
	| OCOOrderOptions;

export type IStopOrder = IStopLimitOrder | IStopMarketOrder;
export type IOrder = ILimitOrder | IStopOrder;

/**
 * A single execution between a resting (maker) and an incoming (taker) order.
 * Self-trade prevention never produces a trade.
 */
export interface Trade {
	/** Unique (per book) trade identifier. */
	tradeId: string;
	/** Id of the resting order. */
	makerOrderId: string;
	/** Id of the incoming order (for activated stop orders, the stop order id). */
	takerOrderId: string;
	/** Aggressor side (the side of the taker). */
	side: Side;
	/** Execution price (the maker's price). */
	price: number;
	/** Executed size. */
	size: number;
	/** Time of execution, from the book clock. */
	timestamp: number;
	/** Monotonic per-book sequence number. */
	seq: number;
	makerAccountId?: string;
	takerAccountId?: string;
	makerOwner?: unknown;
	takerOwner?: unknown;
	makerMeta?: unknown;
	takerMeta?: unknown;
}

/** A price level with total size and number of resting orders. */
export interface DepthLevel {
	price: number;
	size: number;
	count: number;
}

/**
 * Represents the result of processing an order.
 */
export interface IProcessOrder {
	/** Array of fully processed orders. */
	done: IOrder[];
	/** Array of activated (stop limit or stop market) orders */
	activated: IStopOrder[];
	/** The partially processed order, if any. */
	partial: ILimitOrder | null;
	/** The quantity that has been processed in the partial order. */
	partialQuantityProcessed: number;
	/** The remaining quantity that needs to be processed. */
	quantityLeft: number;
	/** The error encountered during order processing, if any. */
	err: OrderBookError | null;
	/** Optional journal log entry related to the order processing. */
	log?: JournalLog;
	/** Orders expired due to Self-Trade Prevention (STP). */
	stpExpired?: IOrder[];
	/**
	 * Executions generated while processing the order (including those of
	 * activated stop orders), in match order. Present even when `err` is set,
	 * as executions that already happened cannot be undone.
	 */
	trades: Trade[];
	/** Book sequence number assigned to the operation (lower than the seq of its trades). */
	seq: number;
	/**
	 * Set only by a successful `modify`. `true` when the order kept its place in
	 * the queue (size decrease, or no change, at the same price); `false` when it
	 * was re-entered at the back of its (possibly new) price level.
	 */
	priorityKept?: boolean;
}

export interface ConditionOrderOptions {
	stopPrice: number;
}

/**
 * Specific options for modifying an order.
 */
export interface ModifyOrderOptions {
	/** Unique identifier of the order. */
	orderID: string;
	/** Details of the order update (price and/or size). */
	orderUpdate: OrderUpdate;
}

/**
 * Specific options for canceling an order.
 */
export interface CancelOrderOptions {
	/** Unique identifier of the order. */
	orderID: string;
}

/**
 * Represents a log entry for a market order operation.
 */
interface MarketOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'm' for market order. */
	op: "m";
	/** Specific options for the market order. */
	o: MarketOrderOptions;
}

/**
 * Represents a log entry for a limit order operation.
 */
interface LimitOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'l' for limit order. */
	op: "l";
	/** Specific options for the limit order. */
	o: LimitOrderOptions;
}

/**
 * Represents a log entry for a stop_market order operation.
 */
interface StopMarketOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'sm' for stop_market order. */
	op: "sm";
	/** Specific options for the stop_market order. */
	o: StopMarketOrderOptions;
}

/**
 * Represents a log entry for a stop_limit order operation.
 */
interface StopLimitOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'l' for stop_limit order. */
	op: "sl";
	/** Specific options for the stop_limit order. */
	o: StopLimitOrderOptions;
}

/**
 * Represents a log entry for a oco order operation.
 */
interface OCOOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'l' for oco order. */
	op: "oco";
	/** Specific options for the oco order. */
	o: OCOOrderOptions;
}

/**
 * Represents a log entry for an order modification operation.
 */
interface ModifyOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'u' for update order. */
	op: "u";
	/** Specific options for modifying the order. */
	o: ModifyOrderOptions;
}

/**
 * Represents a log entry for an order cancellation operation.
 */
interface CancelOrderJournalLog {
	/** Incremental ID of the operation */
	opId: number;
	/** Timestamp of the operation. */
	ts: number;
	/** Operation type: 'd' for delete order. */
	op: "d";
	/** Specific options for canceling the order. */
	o: CancelOrderOptions;
}

/**
 * Discriminated union of all journaling log types.
 */
export type JournalLog =
	| MarketOrderJournalLog
	| LimitOrderJournalLog
	| StopMarketOrderJournalLog
	| StopLimitOrderJournalLog
	| OCOOrderJournalLog
	| ModifyOrderJournalLog
	| CancelOrderJournalLog;

export type CreateOrderOptions =
	| ({ type: OrderType.MARKET } & MarketOrderOptions)
	| ({ type: OrderType.LIMIT } & LimitOrderOptions)
	| ({ type: OrderType.STOP_MARKET } & StopMarketOrderOptions)
	| ({ type: OrderType.STOP_LIMIT } & StopLimitOrderOptions)
	| ({ type: OrderType.OCO } & OCOOrderOptions);

/**
 * Represents a cancel order operation.
 */
export interface ICancelOrder {
	order: ILimitOrder;
	stopOrder?: IStopOrder;
	/** Optional log related to the order cancellation. */
	log?: CancelOrderJournalLog;
}

/**
 * Options for configuring the order book.
 */
export interface OrderBookOptions {
	/**
	 * Orderbook snapshot to restore from. The restoration
	 * will be executed before processing any journal logs, if any.
	 */
	snapshot?: Snapshot;
	/** Flag to enable journaling. */
	enableJournaling?: boolean;
	/** Array of journal logs. */
	journal?: JournalLog[];
	/** Time source used for orders, trades, journal logs and snapshots. Defaults to `Date.now`. */
	clock?: () => number;
	/** Called synchronously for each trade after the operation has been applied. Not called during journal replay. */
	onTrade?: (trade: Trade) => void;
}

/**
 * Represents an update to the price of an order.
 */
export interface OrderUpdatePrice {
	/** New price of the order. */
	price: number;
	/** New size of the order (optional). */
	size?: number;
}

/**
 * Represents an update to the size of an order.
 */
export interface OrderUpdateSize {
	/** New price of the order (optional). */
	price?: number;
	/** New size of the order. */
	size: number;
}

/**
 * Update passed to `modify`. At least one of `price` or `size` must be set,
 * otherwise `modify` returns `INVALID_PRICE_OR_QUANTITY`.
 */
export interface OrderUpdate {
	/** New limit price. */
	price?: number;
	/** New open (resting) size of the order. */
	size?: number;
}

/**
 * Interface to represent a snapshot of the order book
 */
export interface Snapshot {
	/** List of ask orders, each with a price and a list of associated orders */
	asks: Array<{
		/** Price of the ask order */
		price: number;
		/** List of orders associated with this price */
		orders: ILimitOrder[];
	}>;
	/** List of bid orders, each with a price and a list of associated orders */
	bids: Array<{
		/** Price of the bid order */
		price: number;
		/** List of orders associated with this price */
		orders: ILimitOrder[];
	}>;
	stopBook: {
		asks: Array<{
			price: number;
			orders: IStopOrder[];
		}>;
		bids: Array<{
			price: number;
			orders: IStopOrder[];
		}>;
	};
	/** Unix timestamp representing when the snapshot was taken */
	ts: number;
	/** The id of the last operation inserted in the orderbook */
	lastOp: number;
	/** Book sequence number at snapshot time */
	seq?: number;
}
/* node:coverage enable */
