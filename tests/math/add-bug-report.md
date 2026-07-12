# Add Function Bug Report & Analysis

## Function Under Review

```typescript
export function add(a: unknown, b: unknown): unknown {
	return a + b;
}
```

## Test Results Summary
- **Total tests**: 29
- **Passed**: 29
- **Failed**: 0
- **Test coverage**: Happy path, edge cases, type coercion, bigint, symbols, objects, arrays, null, undefined, Infinity, NaN

## Findings

### 1. Type Coercion Bugs
**Severity: Moderate**

The function relies entirely on JavaScript's + operator behavior:
- Empty string `''` does NOT coerce to 0; it's concatenated as `'' + 5 = '5'`
- Numeric strings are NOT converted; they're concatenated (`'5' + 3 = '53'`)
- Whitespace-only strings are concatenated, not converted to 0
- Boolean values coerce: `true -> 1`, `false -> 0`

**Example**:
```javascript
add('5', 3) // Returns '53' (concatenation), not 8 (numeric addition)
add('', 5)  // Returns '5', not 5 (not coerced to 0)
```

**Recommendation**: Add explicit type checking and/or use `Number()` coercion or throw on non-numeric inputs.

---

### 2. Missing Input Validation
**Severity: Low to Moderate**

No validation of inputs. Any input can be passed, leading to:
- Unpredictable string concatenation
- Type errors with BigInt/Symbol
- Silent failures with objects/arrays

**Example**:
```javascript
add({ foo: 'bar' }, 5) // Returns '[object Object]5' (object.toString() coerced)
add([1,2,3], 5)        // Returns '1,2,35' (array.toString() coerced)
```

**Recommendation**: Add input type guards or throw on unsupported types.

---

### 3. Missing Edge Cases
**Severity: Low**

Several edge cases expose unexpected behavior:

#### BigInt Handling
- **Severity**: Critical for type safety
```javascript
add(10n, 5) // Throws TypeError: Invalid mix of BigInt and other type
```
Function throws rather than handling or validating.

#### Symbol Handling
- **Severity**: Low (Symbols are rarely used this way)
```javascript
add(Symbol('test'), 5) // Throws TypeError: Cannot convert a symbol to a number
add(Symbol('a'), Symbol('b')) // Throws TypeError
```

#### Object/Array Handling
- **Severity**: Moderate
```javascript
add({ a: 1 }, 5) // Returns '[object Object]5'
add([1,2,3], 5) // Returns '1,2,35'
```
JavaScript calls `toString()` on objects/arrays, which may not be intended.

#### Negative Zero
```javascript
add(-0, 5)       // Returns 5
add(-0, -0)      // Returns -0
```
Works as expected in IEEE 754.

---

### 4. Correctness & Safety Issues
**Severity: Moderate**

The function's signature suggests numeric addition (`add`, TypeScript type hints), but behavior is unclear:
- Accepts `unknown` (no safety guarantees)
- Returns `unknown` (caller must infer type)
- No documentation of what "add" means (string concatenation? numeric? coercion?)

**Risk**: Callers may expect numeric addition but get string concatenation or TypeError.

---

### 5. Intent Match
**Severity: Moderate**

The function name `add` and TypeScript signature suggest numeric addition, but:
1. No explicit numeric validation
2. No coercion documented
3. String inputs behave unexpectedly

**Recommendation**:
- **Option A (strict numeric)**: Throw TypeError on non-numeric inputs
- **Option B (explicit coercion)**: Use `Number()` conversion for strings
- **Option C (document behavior)**: Clearly document that strings are concatenated, not converted

---

## Recommended Fixes

### Option 1: Strict Numeric Addition (Recommended for utility functions)

```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```

Pros:
- Clear intent (numeric addition only)
- Type-safe (TypeScript catches non-numeric inputs at compile time)
- No unexpected coercion

Cons:
- Breaks existing code that uses string concatenation

### Option 2: Safe Coercion with Validation

```typescript
export function add(a: unknown, b: unknown): number {
  const numA = Number(a);
  const numB = Number(b);

  if (Number.isNaN(numA) || Number.isNaN(numB)) {
    throw new TypeError('Both arguments must be numbers or coercible to numbers');
  }

  return numA + numB;
}
```

Pros:
- Handles strings, booleans, null, undefined
- Still fails on BigInt/Symbol
- Explicit error message

Cons:
- Still has implicit coercion edge cases
- May silently fail on values like `NaN`

### Option 3: Explicit Concatenation (for string operations)

```typescript
export function add(a: unknown, b: unknown): string {
  return String(a) + String(b);
}
```

Pros:
- Predictable behavior
- Handles all types

Cons:
- Function name is misleading for string concatenation

---

## Severity Summary

| Issue | Severity | Fix Warranted? |
|-------|----------|----------------|
| Type coercion (strings not converted) | Moderate | Yes - misleading behavior |
| Missing input validation | Low-Moderate | Yes - type safety |
| BigInt TypeError | Low | Optional - depends on use case |
| Symbol TypeError | Low | No - symbols are rare |
| Object/array coercion | Moderate | Yes - unexpected behavior |
| Intent mismatch | Moderate | Yes - clarify API |

---

## Conclusion

The function works as written, but exposes JavaScript's implicit coercion behavior which is often surprising. Given the function name and TypeScript signature, it should be fixed to provide more predictable behavior. Option 1 (strict numeric) is recommended unless string concatenation is an explicit use case.
