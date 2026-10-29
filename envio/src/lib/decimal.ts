import { BigDecimal } from "envio";

// graph-node rounds every BigDecimal result to 34 significant digits,
// half-up. Divide with ample headroom, then round the same way after each
// operation so values match the subgraph string for string.
const Exact = BigDecimal.clone({
  DECIMAL_PLACES: 200,
  ROUNDING_MODE: BigDecimal.ROUND_DOWN,
  EXPONENTIAL_AT: 1e9,
});
type Exact = InstanceType<typeof Exact>;

function norm(x: Exact): Exact {
  return x.isZero() ? new Exact(0) : x.precision(34, BigDecimal.ROUND_HALF_UP);
}
function out(x: Exact): BigDecimal {
  return new BigDecimal(x.toFixed());
}
export const ZERO_DECIMAL = new BigDecimal(0);

/** total.toBigDecimal().div(shareSupply.toBigDecimal()) */
export function ratio(numerator: bigint, denominator: bigint): BigDecimal {
  return out(norm(new Exact(numerator.toString()).div(denominator.toString())));
}

/** rewardRate * 31536000 * (10000 - treasuryRatio) / 10000 / total, step by step. */
export function aprOf(
  rewardRate: bigint,
  treasuryRatio: bigint,
  total: bigint,
): BigDecimal {
  let x = norm(new Exact((rewardRate * 31536000n).toString()));
  x = norm(x.times((10000n - treasuryRatio).toString()));
  x = norm(x.div("10000"));
  x = norm(x.div(total.toString()));
  return out(x);
}
