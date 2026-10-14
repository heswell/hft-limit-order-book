import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OrderBook,
	type OrderUpdate,
	SelfTradePreventionMode,
	Side,
	TimeInForce,
	type Trade,
} from "../src";
import { ErrorCodes } from "../src/errors";
import type { JournalLog } from "../src/types";

const mk = (opts = {}) => {
	let t = 1000;
	return new OrderBook({ clock: () => ++t, ...opts });
};

// Order ids at a price level, front of the queue first
const queueAt = (ob: OrderBook, side: Side, price: number): string[] => {
	// @ts-expect-error bids/asks are private
	const orderSide = side === Side.BUY ? ob.bids : ob.asks;
	const queue = orderSide.priceTree().get(price);
	return queue === undefined ? [] : queue.toArray().map((o) => o.id);
};

// Rebuilds side aggregates from the resting orders
const assertAggregates = (ob: OrderBook) => {
	for (const name of ["bids", "asks"]) {
		// @ts-expect-error bids/asks are private
		const side = ob[name];
		let volume = 0;
		let total = 0;
		for (const queue of side.priceTree().values) {
			let levelVolume = 0;
			for (const o of queue.toArray()) {
				levelVolume += o.size;
				total += o.size * o.price;
			}
			assert.equal(queue.volume(), levelVolume, `${name} level volume`);
			volume += levelVolume;
		}
		assert.equal(side.volume(), volume, `${name} volume`);
		assert.equal(side.total(), total, `${name} total`);
	}
};

const threeBids = () => {
	const ob = mk();
	ob.limit({ side: Side.BUY, id: "a", size: 10, price: 100 });
	ob.limit({ side: Side.BUY, id: "b", size: 10, price: 100 });
	ob.limit({ side: Side.BUY, id: "c", size: 10, price: 100 });
	return ob;
};

describe("modify priority", () => {
	it("size decrease at the same price keeps queue position and time", () => {
		const ob = threeBids();
		const before = ob.order("a");
		const r = ob.modify("a", { size: 4 });
		assert.equal(r.err, null);
		assert.equal(r.priorityKept, true);
		assert.equal(r.quantityLeft, 4);
		assert.deepEqual(queueAt(ob, Side.BUY, 100), ["a", "b", "c"]);
		const after = ob.order("a");
		assert.equal(after?.size, 4);
		assert.equal(after?.time, before?.time);
		assert.deepEqual(ob.depth(), [[], [[100, 24]]]);
		assertAggregates(ob);

		// The reduced order still trades first
		const m = ob.market({ side: Side.SELL, size: 5 });
		assert.deepEqual(
			m.trades.map((t) => [t.makerOrderId, t.size]),
			[
				["a", 4],
				["b", 1],
			],
		);
		assertAggregates(ob);
	});

	it("size decrease of a middle order keeps it in the middle", () => {
		const ob = threeBids();
		const r = ob.modify("b", { size: 1, price: 100 });
		assert.equal(r.priorityKept, true);
		assert.deepEqual(queueAt(ob, Side.BUY, 100), ["a", "b", "c"]);
		assertAggregates(ob);
	});

	it("unchanged size and price is a no-op that keeps priority", () => {
		const ob = threeBids();
		const r = ob.modify("a", { size: 10, price: 100 });
		assert.equal(r.err, null);
		assert.equal(r.priorityKept, true);
		assert.deepEqual(queueAt(ob, Side.BUY, 100), ["a", "b", "c"]);
		assertAggregates(ob);
	});

	it("size increase loses priority and goes to the back of the level", () => {
		const ob = threeBids();
		const before = ob.order("a");
		const r = ob.modify("a", { size: 15 });
		assert.equal(r.err, null);
		assert.equal(r.priorityKept, false);
		assert.deepEqual(queueAt(ob, Side.BUY, 100), ["b", "c", "a"]);
		assert.ok((ob.order("a")?.time ?? 0) > (before?.time ?? 0));
		assert.equal(ob.order("a")?.size, 15);
		assert.deepEqual(ob.depth(), [[], [[100, 35]]]);
		assertAggregates(ob);
	});

	it("price change moves the order to the back of the new level", () => {
		const ob = threeBids();
		ob.limit({ side: Side.BUY, id: "x", size: 5, price: 99 });
		ob.limit({ side: Side.BUY, id: "y", size: 5, price: 99 });
		const r = ob.modify("a", { price: 99 });
		assert.equal(r.err, null);
		assert.equal(r.priorityKept, false);
		assert.deepEqual(queueAt(ob, Side.BUY, 100), ["b", "c"]);
		assert.deepEqual(queueAt(ob, Side.BUY, 99), ["x", "y", "a"]);
		assert.equal(ob.order("a")?.size, 10);
		assert.deepEqual(ob.depth(), [
			[],
			[
				[100, 20],
				[99, 20],
			],
		]);
		assertAggregates(ob);
	});

	it("price change with a size decrease still loses priority", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "a", size: 10, price: 101 });
		ob.limit({ side: Side.SELL, id: "b", size: 10, price: 102 });
		const r = ob.modify("a", { price: 102, size: 3 });
		assert.equal(r.priorityKept, false);
		assert.deepEqual(queueAt(ob, Side.SELL, 102), ["b", "a"]);
		assert.deepEqual(ob.depth(), [[[102, 13]], []]);
		assertAggregates(ob);
	});

	it("price change that crosses trades and rests the remainder", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s", size: 4, price: 101 });
		ob.limit({ side: Side.BUY, id: "b", size: 10, price: 100 });
		const trades: Trade[] = [];
		const ob2 = mk({ onTrade: (t: Trade) => trades.push(t) });
		ob2.limit({ side: Side.SELL, id: "s", size: 4, price: 101 });
		ob2.limit({ side: Side.BUY, id: "b", size: 10, price: 100 });
		for (const book of [ob, ob2]) {
			const r = book.modify("b", { price: 101 });
			assert.equal(r.err, null);
			assert.equal(r.priorityKept, false);
			assert.deepEqual(
				r.trades.map((t) => [t.makerOrderId, t.takerOrderId, t.size]),
				[["s", "b", 4]],
			);
			assert.equal(book.order("b")?.size, 6);
			assert.deepEqual(book.depth(), [[], [[101, 6]]]);
			assertAggregates(book);
		}
		assert.equal(trades.length, 1);
	});
});

describe("modify preserves order attributes", () => {
	it("keeps timeInForce, postOnly, stpMode, accountId, owner and meta", () => {
		const ob = mk();
		ob.limit({
			side: Side.BUY,
			id: "a",
			size: 10,
			price: 100,
			postOnly: true,
			accountId: "acc",
			stpMode: SelfTradePreventionMode.EXPIRE_MAKER,
			owner: "o",
			meta: { m: 1 },
		});
		for (const update of [{ size: 5 }, { size: 8 }, { price: 99 }]) {
			const r = ob.modify("a", update);
			assert.equal(r.err, null);
			const o = ob.order("a");
			assert.equal(o?.timeInForce, TimeInForce.GTC);
			assert.equal(o?.accountId, "acc");
			assert.equal(o?.stpMode, SelfTradePreventionMode.EXPIRE_MAKER);
			assert.equal(o?.owner, "o");
			assert.deepEqual(o?.meta, { m: 1 });
		}
		// @ts-expect-error orders is private
		assert.equal(ob.orders.a.postOnly, true);
	});

	it("applies the preserved stpMode when a price change crosses", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s", size: 5, price: 101, accountId: "x" });
		ob.limit({
			side: Side.BUY,
			id: "b",
			size: 5,
			price: 100,
			accountId: "x",
			stpMode: SelfTradePreventionMode.EXPIRE_MAKER,
		});
		const r = ob.modify("b", { price: 101 });
		assert.equal(r.err, null);
		assert.equal(r.trades.length, 0);
		assert.deepEqual(
			r.stpExpired?.map((o) => o.id),
			["s"],
		);
		assert.equal(ob.order("b")?.price, 101);
		assertAggregates(ob);
	});

	it("rejects a postOnly re-price that would cross and leaves the order", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s", size: 5, price: 101 });
		ob.limit({ side: Side.BUY, id: "b", size: 5, price: 100, postOnly: true });
		const r = ob.modify("b", { price: 101 });
		assert.equal(r.err?.code, ErrorCodes.LIMIT_ORDER_POST_ONLY);
		assert.equal(r.priorityKept, undefined);
		assert.equal(ob.order("b")?.price, 100);
		assert.equal(ob.order("s")?.size, 5);
		assertAggregates(ob);
		// A non-crossing re-price is fine
		assert.equal(ob.modify("b", { price: 100.5 }).err, null);
	});

	it("keeps the OCO link and cancels the stop leg when the limit trades", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 1, price: 100 });
		ob.market({ side: Side.BUY, size: 1 }); // marketPrice = 100
		ob.oco({
			side: Side.BUY,
			id: "oco",
			size: 5,
			price: 95,
			stopPrice: 110,
			stopLimitPrice: 111,
		});
		// Re-price without trading: the stop leg stays linked
		ob.modify("oco", { price: 96 });
		// @ts-expect-error stopBook is private
		assert.equal(ob.stopBook.bids._priceTree.length, 1);

		ob.limit({ side: Side.SELL, id: "s2", size: 2, price: 97 });
		const r = ob.modify("oco", { price: 97 });
		assert.equal(r.err, null);
		assert.equal(r.trades.length, 1);
		assert.equal(ob.order("oco")?.size, 3);
		// @ts-expect-error stopBook is private
		assert.equal(ob.stopBook.bids._priceTree.length, 0);
	});

	it("cancel after a re-price still removes the OCO stop leg", () => {
		const ob = mk();
		ob.limit({ side: Side.SELL, id: "s1", size: 1, price: 100 });
		ob.market({ side: Side.BUY, size: 1 });
		ob.oco({
			side: Side.BUY,
			id: "oco",
			size: 5,
			price: 95,
			stopPrice: 110,
			stopLimitPrice: 111,
		});
		ob.modify("oco", { price: 96 });
		const c = ob.cancel("oco");
		assert.equal(c?.stopOrder?.id, "oco");
		// @ts-expect-error stopBook is private
		assert.equal(ob.stopBook.bids._priceTree.length, 0);
	});
});

describe("modify invalid input", () => {
	const invalid: unknown[] = [
		undefined,
		null,
		{},
		{ size: 0 },
		{ size: -1 },
		{ price: 0 },
		{ price: -5 },
		{ size: Number.NaN },
		{ price: Number.POSITIVE_INFINITY },
		{ size: "5" },
		{ price: 100, size: 0 },
	];
	for (const update of invalid) {
		it(`rejects ${JSON.stringify(update) ?? String(update)} and leaves the order`, () => {
			const ob = mk({ enableJournaling: true });
			ob.limit({ side: Side.BUY, id: "a", size: 10, price: 100 });
			ob.limit({ side: Side.BUY, id: "b", size: 10, price: 100 });
			const seq = ob.seq;
			const lastOp = ob.lastOp;
			const r = ob.modify("a", update as OrderUpdate);
			assert.equal(r.err?.code, ErrorCodes.INVALID_PRICE_OR_QUANTITY);
			assert.equal(r.priorityKept, undefined);
			assert.equal(r.log, undefined);
			assert.equal(ob.seq, seq);
			assert.equal(ob.lastOp, lastOp);
			assert.deepEqual(queueAt(ob, Side.BUY, 100), ["a", "b"]);
			assert.equal(ob.order("a")?.size, 10);
			assertAggregates(ob);
		});
	}

	it("returns ORDER_NOT_FOUND for unknown ids", () => {
		const ob = mk();
		const r = ob.modify("nope", { size: 1 });
		assert.equal(r.err?.code, ErrorCodes.ORDER_NOT_FOUND);
	});
});

describe("modify journal and snapshot", () => {
	it("replaying the journal reproduces queue order and sizes", () => {
		const ob = mk({ enableJournaling: true });
		const journal: JournalLog[] = [];
		const push = (r: { log?: JournalLog }) => {
			if (r.log) journal.push(r.log);
		};
		push(ob.limit({ side: Side.BUY, id: "a", size: 10, price: 100 }));
		push(ob.limit({ side: Side.BUY, id: "b", size: 10, price: 100 }));
		push(ob.limit({ side: Side.BUY, id: "c", size: 10, price: 100 }));
		const r1 = ob.modify("a", { size: 3 });
		assert.equal(r1.log?.op, "u");
		assert.deepEqual(r1.log?.o, { orderID: "a", orderUpdate: { size: 3 } });
		push(r1);
		push(ob.modify("b", { size: 20 }));
		push(ob.modify("c", { price: 99 }));
		assert.deepEqual(queueAt(ob, Side.BUY, 100), ["a", "b"]);

		const replayed = mk({ journal });
		assert.deepEqual(queueAt(replayed, Side.BUY, 100), ["a", "b"]);
		assert.deepEqual(queueAt(replayed, Side.BUY, 99), ["c"]);
		assert.deepEqual(replayed.depth(), ob.depth());
		assert.equal(replayed.seq, ob.seq);
		assertAggregates(replayed);

		const restored = new OrderBook({ snapshot: ob.snapshot() });
		assert.deepEqual(queueAt(restored, Side.BUY, 100), ["a", "b"]);
		assert.deepEqual(restored.depth(), ob.depth());
	});

	it("assigns a sequence number to each successful modify", () => {
		const ob = threeBids();
		const seq = ob.seq;
		assert.equal(ob.modify("a", { size: 1 }).seq, seq + 1);
		assert.equal(ob.modify("a", { size: 2 }).seq, seq + 2);
		assert.equal(ob.seq, seq + 2);
	});
});
