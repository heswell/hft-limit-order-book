import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OrderBook,
	OrderType,
	SelfTradePreventionMode,
	Side,
	TimeInForce,
	type Trade,
} from "../src";

const mk = (opts = {}) => {
	let t = 1000;
	return new OrderBook({ clock: () => ++t, ...opts });
};

describe("trades", () => {
	it("partial fill of a resting order", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 10, price: 100 });
		const r = ob.limit({ side: Side.BUY, id: "b1", size: 4, price: 100 });
		assert.equal(r.trades.length, 1);
		const t = r.trades[0];
		assert.equal(t.makerOrderId, "s1");
		assert.equal(t.takerOrderId, "b1");
		assert.equal(t.side, Side.BUY);
		assert.equal(t.price, 100);
		assert.equal(t.size, 4);
		assert.equal(ob.order("s1")?.size, 6);
	});

	it("sweeps levels at maker prices and leaves remainder", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		ob.limit({ side: Side.SELL, id: "s2", size: 3, price: 101 });
		ob.limit({ side: Side.SELL, id: "s3", size: 5, price: 102 });
		const r = ob.limit({ side: Side.BUY, id: "b", size: 7, price: 105 });
		assert.deepEqual(
			r.trades.map((t) => [t.makerOrderId, t.price, t.size]),
			[
				["s1", 100, 2],
				["s2", 101, 3],
				["s3", 102, 2],
			],
		);
		assert.equal(r.quantityLeft, 0);
		assert.equal(ob.order("s3")?.size, 3);
	});

	it("rests the unfilled remainder of a limit order", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		const r = ob.limit({ side: Side.BUY, id: "b", size: 5, price: 100 });
		assert.equal(r.trades.length, 1);
		assert.equal(ob.order("b")?.size, 3);
	});

	it("IOC reports trades and does not rest", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		const r = ob.limit({
			side: Side.BUY,
			id: "b",
			size: 5,
			price: 100,
			timeInForce: TimeInForce.IOC,
		});
		assert.equal(r.trades.length, 1);
		assert.equal(r.trades[0].size, 2);
		assert.equal(ob.order("b"), undefined);
	});

	it("FOK not fillable yields no trades; fillable yields trades", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		const bad = ob.limit({
			side: Side.BUY,
			id: "b1",
			size: 5,
			price: 100,
			timeInForce: TimeInForce.FOK,
		});
		assert.notEqual(bad.err, null);
		assert.equal(bad.trades.length, 0);
		const ok = ob.limit({
			side: Side.BUY,
			id: "b2",
			size: 2,
			price: 100,
			timeInForce: TimeInForce.FOK,
		});
		assert.equal(ok.err, null);
		assert.equal(ok.trades.length, 1);
	});

	it("market orders use supplied id, or generate one", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 5, price: 100 });
		const a = ob.market({ side: Side.BUY, id: "m1", size: 2 });
		assert.equal(a.trades[0].takerOrderId, "m1");
		assert.equal(a.trades[0].side, Side.BUY);
		const b = ob.market({ side: Side.BUY, size: 1 });
		assert.ok(b.trades[0].takerOrderId.length > 0);
		const dup = ob.market({ side: Side.BUY, id: "s1", size: 1 });
		assert.notEqual(dup.err, null);
	});

	it("market sell reports sell aggressor", () => {
		const ob = mk();
		ob.limit({ side: Side.BUY, id: "b1", size: 5, price: 100 });
		const r = ob.market({ side: Side.SELL, id: "m", size: 3 });
		assert.equal(r.trades[0].side, Side.SELL);
		assert.equal(r.trades[0].price, 100);
	});

	it("deterministic clock and monotonic seq", () => {
		const ob = mk();
		const r1 = ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		const r2 = ob.limit({ side: Side.BUY, id: "b1", size: 1, price: 100 });
		const r3 = ob.limit({ side: Side.BUY, id: "b2", size: 1, price: 100 });
		assert.equal(ob.order("s1"), undefined);
		assert.ok(r1.seq < r2.seq);
		assert.ok(r2.seq < r2.trades[0].seq);
		assert.ok(r2.trades[0].seq < r3.seq);
		assert.ok(r3.seq < r3.trades[0].seq);
		assert.equal(ob.seq, r3.trades[0].seq);
		assert.equal(r2.trades[0].timestamp, 1002);
		assert.equal(r3.trades[0].timestamp, 1003);
	});

	it("clock is used for order time and snapshot", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		assert.equal(ob.order("s1")?.time, 1001);
		assert.equal(ob.snapshot().ts, 1002);
	});

	it("invalid operations do not consume a seq", () => {
		const ob = mk();
		const before = ob.seq;
		const r = ob.limit({ side: Side.BUY, id: "x", size: 0, price: 1 });
		assert.notEqual(r.err, null);
		assert.equal(ob.seq, before);
	});

	it("onTrade fires per execution in order", () => {
		const seen: Trade[] = [];
		const ob = mk({ onTrade: (t: Trade) => seen.push(t) });
		ob.limit({ side: Side.SELL, id: "s1", size: 1, price: 100 });
		ob.limit({ side: Side.SELL, id: "s2", size: 1, price: 101 });
		const r = ob.market({ side: Side.BUY, id: "m", size: 2 });
		assert.deepEqual(seen, r.trades);
		assert.equal(seen.length, 2);
	});

	it("onTrade is not fired while replaying a journal", () => {
		const log = mk({ enableJournaling: true });
		const journal = [
			log.limit({ side: Side.SELL, id: "s1", size: 1, price: 100 }).log,
			log.market({ side: Side.BUY, id: "m", size: 1 }).log,
		];
		let n = 0;
		new OrderBook({
			journal: journal as never,
			onTrade: () => n++,
			clock: () => 1,
		});
		assert.equal(n, 0);
	});

	it("passes owner/meta to orders, snapshots and trades", () => {
		const ob = mk();
		ob.limit({
			side: Side.SELL,
			id: "s1",
			size: 2,
			price: 100,
			owner: "alice",
			meta: { a: 1 },
		});
		assert.equal(ob.order("s1")?.owner, "alice");
		assert.deepEqual(ob.snapshot().asks[0].orders[0].owner, "alice");
		const r = ob.market({
			side: Side.BUY,
			id: "m",
			size: 1,
			owner: "bob",
			meta: "x",
		});
		const t = r.trades[0];
		assert.equal(t.makerOwner, "alice");
		assert.deepEqual(t.makerMeta, { a: 1 });
		assert.equal(t.takerOwner, "bob");
		assert.equal(t.takerMeta, "x");
		const ob2 = new OrderBook({ snapshot: ob.snapshot() });
		assert.equal(ob2.order("s1")?.owner, "alice");
	});

	it("modify keeps owner and meta", () => {
		const ob = mk();
		ob.limit({ side: Side.BUY, id: "b", size: 2, price: 99, owner: "al" });
		ob.modify("b", { size: 3 });
		assert.equal(ob.order("b")?.owner, "al");
	});

	it("stop activation produces trades with the stop id as taker", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 5, price: 100 });
		ob.limit({ side: Side.SELL, id: "s2", size: 5, price: 101 });
		const stop = ob.stopLimit({
			side: Side.BUY,
			id: "st",
			size: 2,
			price: 105,
			stopPrice: 100,
		});
		assert.equal(stop.err, null);
		const r = ob.limit({ side: Side.BUY, id: "b", size: 1, price: 100 });
		assert.equal(r.trades.length, 2);
		assert.equal(r.trades[0].takerOrderId, "b");
		assert.equal(r.trades[1].takerOrderId, "st");
		assert.ok(r.trades[0].seq < r.trades[1].seq);
	});

	it("STP never produces trades", () => {
		const ob = mk();
		ob.limit({
			side: Side.SELL,
			id: "s1",
			size: 2,
			price: 100,
			accountId: "A",
			stpMode: SelfTradePreventionMode.EXPIRE_MAKER,
		});
		const r = ob.limit({
			side: Side.BUY,
			id: "b",
			size: 2,
			price: 100,
			accountId: "A",
			stpMode: SelfTradePreventionMode.EXPIRE_MAKER,
		});
		assert.equal(r.trades.length, 0);
	});

	it("post-only crossing is rejected without trades", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 2, price: 100 });
		const r = ob.limit({
			side: Side.BUY,
			id: "b",
			size: 2,
			price: 100,
			postOnly: true,
		});
		assert.notEqual(r.err, null);
		assert.equal(r.trades.length, 0);
	});

	it("depth limits levels and depthDetailed reports counts", () => {
		const ob = mk();
		for (const [i, p] of [100, 101, 102].entries()) {
			ob.limit({ side: Side.SELL, id: `a${i}`, size: 1, price: p });
			ob.limit({ side: Side.BUY, id: `b${i}`, size: 1, price: p - 10 });
		}
		ob.limit({ side: Side.SELL, id: "a9", size: 4, price: 100 });
		assert.equal(ob.depth()[0].length, 3);
		assert.deepEqual(ob.depth(2), [
			[
				[100, 5],
				[101, 1],
			],
			[
				[92, 1],
				[91, 1],
			],
		]);
		assert.deepEqual(ob.depth(0), [[], []]);
		const [asks, bids] = ob.depthDetailed(1);
		assert.deepEqual(asks, [{ price: 100, size: 5, count: 2 }]);
		assert.deepEqual(bids, [{ price: 92, size: 1, count: 1 }]);
		assert.equal(OrderType.LIMIT, "limit");
	});
});
