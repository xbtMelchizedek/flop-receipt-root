/** USD decimal string (up to 9 places) -> USDC base units (6 places), rounded up so a solver is never short. */
export function usdToUnits(usd) {
  if (typeof usd !== 'string' || !/^\d+(\.\d{1,9})?$/.test(usd)) throw new Error(`bad USD amount ${usd}`);
  const [w, f = ''] = usd.split('.');
  const nano = BigInt(w) * 10n ** 9n + BigInt(f.padEnd(9, '0'));
  const units = (nano + 999n) / 1000n;
  return units === 0n ? 1n : units;
}
