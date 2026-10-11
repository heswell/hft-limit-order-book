import { test } from 'tap'
import { OrderBook } from '../src/orderbook'
import { Side } from '../src/side'
import { OrderType, TimeInForce } from '../src/order'
import { ERROR } from '../src/errors'
import type { Trade } from '../src/types'

const fixedClock = (start = 1000): (() => number) => {
  let t = start
  return () => t++
}

const book = (extra = {}): { ob: OrderBook, seen: Trade[] } => {
  const seen: Trade[] = []
  const ob = new OrderBook({
    clock: fixedClock(),
    onTrade: (t) => seen.push(t),
    ...extra
  })
  return { ob, seen }
}

void test('no trades when nothing matches', ({ equal, same, end }) => {
  const { ob, seen } = book()
  const r = ob.limit(Side.BUY, 'b1', 5, 100)
  same(r.trades, [])
  equal(seen.length, 0)
  end()
})

void test('limit: partial fill of maker', ({ equal, same, end }) => {
  const { ob, seen } = book()
  ob.limit(Side.SELL, 's1', 10, 100)
  const r = ob.limit(Side.BUY, 'b1', 4, 101)
  equal(r.trades.length, 1)
  const t = r.trades[0]
  equal(t.makerOrderId, 's1')
  equal(t.takerOrderId, 'b1')
  equal(t.side, Side.BUY)
  equal(t.price, 100)
  equal(t.size, 4)
  equal(typeof t.tradeId, 'string')
  equal(ob.order('s1')?.size, 6)
  same(seen, r.trades)
  end()
})

void test('limit: partial fill of taker rests remainder', ({ equal, end }) => {
  const { ob } = book()
  ob.limit(Side.SELL, 's1', 3, 100)
  const r = ob.limit(Side.BUY, 'b1', 10, 100)
  equal(r.trades.length, 1)
  equal(r.trades[0].size, 3)
  equal(ob.order('b1')?.size, 7)
  end()
})

void test('limit: sweep across levels and orders', ({ equal, same, end }) => {
  const { ob, seen } = book()
  ob.limit(Side.SELL, 's1', 2, 100)
  ob.limit(Side.SELL, 's2', 3, 100)
  ob.limit(Side.SELL, 's3', 4, 101)
  ob.limit(Side.SELL, 's4', 5, 105)
  const r = ob.limit(Side.BUY, 'b1', 8, 102)
  same(
    r.trades.map((t) => [t.makerOrderId, t.price, t.size]),
    [['s1', 100, 2], ['s2', 100, 3], ['s3', 101, 3]]
  )
  equal(ob.order('s3')?.size, 1)
  equal(seen.length, 3)
  // trade sizes sum to filled quantity
  equal(r.trades.reduce((a, t) => a + t.size, 0), 8)
  end()
})

void test('limit: sell aggressor sweeps bids at maker prices', ({ same, equal, end }) => {
  const { ob } = book()
  ob.limit(Side.BUY, 'b1', 2, 100)
  ob.limit(Side.BUY, 'b2', 2, 99)
  const r = ob.limit(Side.SELL, 's1', 3, 99)
  same(
    r.trades.map((t) => [t.makerOrderId, t.side, t.price, t.size]),
    [['b1', Side.SELL, 100, 2], ['b2', Side.SELL, 99, 1]]
  )
  equal(ob.order('b2')?.size, 1)
  end()
})

void test('market order: caller id, generated id, sweeps', ({ equal, same, end }) => {
  const { ob } = book()
  ob.limit(Side.SELL, 's1', 2, 100)
  ob.limit(Side.SELL, 's2', 2, 101)
  const r = ob.market(Side.BUY, 3, 'mkt-A')
  same(
    r.trades.map((t) => [t.makerOrderId, t.takerOrderId, t.price, t.size]),
    [['s1', 'mkt-A', 100, 2], ['s2', 'mkt-A', 101, 1]]
  )
  const r2 = ob.market(Side.BUY, 1)
  equal(r2.trades.length, 1)
  equal(typeof r2.trades[0].takerOrderId, 'string')
  equal(r2.trades[0].takerOrderId.length > 0, true)
  const r3 = ob.createOrder(OrderType.MARKET, Side.SELL, 1, undefined, 'x')
  equal(r3.trades.length, 0)
  end()
})

void test('market order: id of resting order rejected; remaining quantity', ({ equal, end }) => {
  const { ob } = book()
  ob.limit(Side.SELL, 's1', 2, 100)
  ob.limit(Side.BUY, 'b1', 1, 50)
  equal(ob.market(Side.BUY, 1, 'b1').err?.message, ERROR.ErrOrderExists)
  const r = ob.market(Side.BUY, 5, 'm1')
  equal(r.quantityLeft, 3)
  equal(r.trades.length, 1)
  end()
})

void test('IOC: trades for fillable part, rest cancelled', ({ equal, end }) => {
  const { ob } = book()
  ob.limit(Side.SELL, 's1', 3, 100)
  const r = ob.limit(Side.BUY, 'b1', 5, 100, TimeInForce.IOC)
  equal(r.trades.length, 1)
  equal(r.trades[0].size, 3)
  equal(r.quantityLeft, 2)
  equal(ob.order('b1'), undefined)
  end()
})

void test('FOK: unfillable yields no trades and no callbacks; fillable trades', ({ equal, end }) => {
  const { ob, seen } = book()
  ob.limit(Side.SELL, 's1', 3, 100)
  const bad = ob.limit(Side.BUY, 'b1', 5, 100, TimeInForce.FOK)
  equal(bad.err?.message, ERROR.ErrLimitFOKNotFillable)
  equal(bad.trades.length, 0)
  equal(seen.length, 0)
  equal(ob.order('s1')?.size, 3)
  const ok = ob.limit(Side.BUY, 'b2', 3, 100, TimeInForce.FOK)
  equal(ok.trades.length, 1)
  equal(seen.length, 1)
  end()
})

void test('modify that crosses produces trades with preserved owner', ({ equal, end }) => {
  const { ob } = book()
  ob.limit(Side.SELL, 's1', 3, 100, TimeInForce.GTC, { owner: 'maker' })
  ob.limit(Side.BUY, 'b1', 3, 90, TimeInForce.GTC, { owner: 'me', meta: { a: 1 } })
  const r = ob.modify('b1', { price: 100 })
  equal(r.trades.length, 1)
  equal(r.trades[0].takerOwner, 'me')
  equal(r.trades[0].makerOwner, 'maker')
  end()
})

void test('deterministic clock is used everywhere', ({ equal, same, end }) => {
  let now = 5000
  const ob = new OrderBook({ clock: () => now, enableJournaling: true })
  const l = ob.limit(Side.SELL, 's1', 5, 100)
  equal(l.log?.ts, 5000)
  equal(ob.order('s1')?.time, 5000)
  now = 6000
  const r = ob.limit(Side.BUY, 'b1', 2, 100)
  equal(r.trades[0].timestamp, 6000)
  equal(r.log?.ts, 6000)
  equal(r.done[0].time, 6000)
  now = 7000
  equal(ob.snapshot().ts, 7000)
  const m = ob.modify('s1', { size: 2 })
  equal(m.log?.ts, 7000)
  equal(ob.order('s1')?.time, 7000)
  now = 8000
  equal(ob.cancel('s1')?.log?.ts, 8000)
  const a = new OrderBook({ clock: () => 1 })
  const b = new OrderBook({ clock: () => 1 })
  for (const x of [a, b]) {
    x.limit(Side.SELL, 's', 5, 10)
    x.market(Side.BUY, 2)
  }
  same(a.snapshot(), b.snapshot())
  end()
})

void test('owner/meta passthrough to orders, snapshots, trades', ({ equal, same, end }) => {
  const { ob } = book()
  ob.limit(Side.SELL, 's1', 5, 100, TimeInForce.GTC, { owner: 'bot1', meta: { k: 1 } })
  equal(ob.order('s1')?.owner, 'bot1')
  same(ob.order('s1')?.toObject().meta, { k: 1 })
  const r = ob.market(Side.BUY, 2, 'm1', { owner: 'bot2', meta: 'x' })
  const t = r.trades[0]
  equal(t.makerOwner, 'bot1')
  equal(t.takerOwner, 'bot2')
  same(t.makerMeta, { k: 1 })
  equal(t.takerMeta, 'x')
  // partially filled maker keeps owner
  equal(ob.order('s1')?.owner, 'bot1')
  const snap = ob.snapshot()
  equal(snap.asks[0].orders[0].owner, 'bot1')
  const ob2 = new OrderBook({ snapshot: snap })
  equal(ob2.order('s1')?.owner, 'bot1')
  // aggregated taker order in done carries owner
  const r2 = ob.limit(Side.BUY, 'b9', 3, 100, TimeInForce.GTC, { owner: 'bot3' })
  equal(r2.done[r2.done.length - 1].owner, 'bot3')
  // owner absent means no keys
  const r3 = new OrderBook()
  r3.limit(Side.SELL, 'a', 1, 1)
  equal('owner' in (r3.order('a')?.toObject() ?? {}), false)
  end()
})

void test('seq is monotonic across operations and trades', ({ equal, ok, end }) => {
  const { ob, seen } = book()
  const a = ob.limit(Side.SELL, 's1', 1, 100)
  const b = ob.limit(Side.SELL, 's2', 1, 100)
  const c = ob.limit(Side.BUY, 'b1', 2, 100)
  ok(a.seq < b.seq && b.seq < c.seq)
  ok(c.trades[0].seq > c.seq)
  ok(c.trades[1].seq > c.trades[0].seq)
  equal(ob.seq, c.trades[1].seq)
  equal(seen.length, 2)
  ob.limit(Side.BUY, 'rest', 1, 50)
  const bad = ob.limit(Side.BUY, 'rest', 2, 50)
  equal(bad.err?.message, ERROR.ErrOrderExists)
  equal(bad.seq, ob.seq)
  const snap = ob.snapshot()
  equal(new OrderBook({ snapshot: snap }).seq, snap.seq)
  end()
})

void test('depth(levels) and depthDetailed', ({ same, end }) => {
  const { ob } = book()
  for (const p of [100, 101, 102]) {
    ob.limit(Side.SELL, `s${p}a`, 1, p)
    ob.limit(Side.SELL, `s${p}b`, 2, p)
  }
  for (const p of [99, 98, 97]) ob.limit(Side.BUY, `b${p}`, 5, p)
  same(ob.depth(2), [[[100, 3], [101, 3]], [[99, 5], [98, 5]]])
  same(ob.depth(0), [[], []])
  same(ob.depth(10)[0].length, 3)
  same(ob.depth().map((s) => s.length), [3, 3])
  same(ob.depthDetailed(1), [
    [{ price: 100, size: 3, count: 2 }],
    [{ price: 99, size: 5, count: 1 }]
  ])
  same(ob.depthDetailed()[0].map((l) => l.count), [2, 2, 2])
  end()
})

void test('postOnly: rejects when crossing, rests otherwise', ({ equal, same, end }) => {
  const { ob, seen } = book()
  ob.limit(Side.SELL, 's1', 5, 100)
  const bad = ob.limit(Side.BUY, 'b1', 1, 100, TimeInForce.GTC, { postOnly: true })
  equal(bad.err?.message, ERROR.ErrPostOnlyWouldCross)
  equal(ob.order('b1'), undefined)
  equal(seen.length, 0)
  equal(ob.order('s1')?.size, 5)
  const ok = ob.limit(Side.BUY, 'b2', 1, 99, TimeInForce.GTC, { postOnly: true })
  equal(ok.err, null)
  equal(ob.order('b2')?.size, 1)
  const badSell = ob.limit(Side.SELL, 's2', 1, 99, TimeInForce.GTC, { postOnly: true })
  equal(badSell.err?.message, ERROR.ErrPostOnlyWouldCross)
  const viaCreate = ob.createOrder(OrderType.LIMIT, Side.BUY, 1, 101, 'b3', TimeInForce.GTC, { postOnly: true })
  equal(viaCreate.err?.message, ERROR.ErrPostOnlyWouldCross)
  same(ob.limit(Side.SELL, 's3', 1, 101, TimeInForce.GTC, { postOnly: true }).err, null)
  end()
})

void test('journal replay restores extras and does not fire onTrade', ({ equal, same, end }) => {
  const live: Trade[] = []
  const ob = new OrderBook({ enableJournaling: true, clock: () => 1, onTrade: (t) => live.push(t) })
  const logs = [
    ob.limit(Side.SELL, 's1', 5, 100, TimeInForce.GTC, { owner: 'o', postOnly: true }).log,
    ob.market(Side.BUY, 2, 'm1', { owner: 'p', meta: 1 }).log
  ]
  equal(live.length, 1)
  same(logs[1]?.o, { side: Side.BUY, size: 2, orderID: 'm1', owner: 'p', meta: 1 })
  const replayed: Trade[] = []
  const ob2 = new OrderBook({ journal: logs as any, clock: () => 1, onTrade: (t) => replayed.push(t) })
  equal(replayed.length, 0)
  equal(ob2.order('s1')?.size, 3)
  equal(ob2.order('s1')?.owner, 'o')
  equal(ob2.seq, ob.seq)
  // replay of crossing postOnly is deterministic
  equal(ob2.limit(Side.SELL, 'z', 1, 100).err, null)
  end()
})

void test('invalid order type result has trades/seq', ({ same, equal, end }) => {
  const ob = new OrderBook()
  // @ts-expect-error invalid type
  const r = ob.createOrder('bad', Side.BUY, 1)
  same(r.trades, [])
  equal(r.seq, 0)
  end()
})
