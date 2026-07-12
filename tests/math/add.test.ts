import { describe, expect, it } from 'bun:test';
import { add } from '../../src/math/add';

describe('add function edge cases', () => {
	describe('happy path - numeric addition', () => {
		it('should add positive numbers correctly', () => {
			const result = add(2, 3);
			expect(result).toBe(5);
		});

		it('should add negative numbers correctly', () => {
			const result = add(-2, -3);
			expect(result).toBe(-5);
		});

		it('should add zero correctly', () => {
			const result = add(5, 0);
			expect(result).toBe(5);
			const result2 = add(0, 5);
			expect(result2).toBe(5);
			const result3 = add(0, 0);
			expect(result3).toBe(0);
		});

		it('should add floats correctly', () => {
			const result = add(1.5, 2.5);
			expect(result).toBe(4);
		});
	});

	describe('edge cases - numeric boundaries', () => {
		it('should handle Infinity', () => {
			const result = add(Infinity, 5);
			expect(result).toBe(Infinity);
		});

		it('should handle -Infinity', () => {
			const result = add(-Infinity, 5);
			expect(result).toBe(-Infinity);
		});

		it('should handle NaN', () => {
			const result = add(NaN, 5);
			expect(Number.isNaN(result)).toBe(true);
		});

		it('should handle NaN + NaN', () => {
			const result = add(NaN, NaN);
			expect(Number.isNaN(result)).toBe(true);
		});
	});

	describe('type coercion cases', () => {
		it('should concatenate empty string with number', () => {
			const result = add('', 5);
			expect(result).toBe('5');
		});

		it('should concatenate whitespace strings', () => {
			const result = add('   ', 5);
			expect(result).toBe('   5');
		});

		it('should concatenate string "5" with number (not numeric conversion)', () => {
			const result = add('5', 3);
			expect(result).toBe('53');
		});

		it('should concatenate decimal strings with numbers', () => {
			const result = add('5.5', 2.5);
			expect(result).toBe('5.52.5');
		});

		it('should concatenate negative string with number', () => {
			const result = add('-5', 3);
			expect(result).toBe('-53');
		});

		it('should concatenate strings when both are strings', () => {
			const result = add('hello', ' world');
			expect(result).toBe('hello world');
		});
	});

	describe('boolean coercion', () => {
		it('should coerce true to 1', () => {
			const result = add(true, 2);
			expect(result).toBe(3);
		});

		it('should coerce false to 0', () => {
			const result = add(false, 5);
			expect(result).toBe(5);
		});

		it('should add true and false', () => {
			const result = add(true, false);
			expect(result).toBe(1);
		});
	});

	describe('bigint', () => {
		it('should handle bigint correctly', () => {
			const result = add(10n, 5n);
			expect(result).toBe(15n);
		});

		it('should throw TypeError when mixing bigint with number', () => {
			expect(() => add(10n, 5)).toThrow(TypeError);
		});
	});

	describe('symbol', () => {
		it('should throw TypeError with symbol', () => {
			const sym = Symbol('test');
			expect(() => add(sym, 5)).toThrow(TypeError);
		});

		it('should throw TypeError with symbol + symbol', () => {
			const sym1 = Symbol('test1');
			const sym2 = Symbol('test2');
			expect(() => add(sym1, sym2)).toThrow(TypeError);
		});
	});

	describe('object and array inputs', () => {
		it('should concatenate object with number', () => {
			const obj = { a: 1 };
			const result = add(obj, 5);
			expect(result).toBe('[object Object]5');
		});

		it('should concatenate array with number', () => {
			const arr = [1, 2, 3];
			const result = add(arr, 5);
			expect(result).toBe('1,2,35');
		});
	});

	describe('null and undefined', () => {
		it('should handle null', () => {
			const result = add(null, 5);
			expect(result).toBe(5);
		});

		it('should handle undefined', () => {
			const result = add(undefined, 5);
			expect(result).toBeNaN();
		});

		it('should handle null + undefined', () => {
			const result = add(null, undefined);
			expect(Number.isNaN(result)).toBe(true);
		});

		it('should handle undefined + undefined', () => {
			const result = add(undefined, undefined);
			expect(Number.isNaN(result)).toBe(true);
		});
	});

	describe('negative zero', () => {
		it('should handle negative zero correctly', () => {
			const result = add(-0, 5);
			expect(result).toBe(5);
		});

		it('should handle negative zero + negative zero', () => {
			const result = add(-0, -0);
			expect(result).toBe(-0);
		});
	});
});
