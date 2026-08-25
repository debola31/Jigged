"""Token pricing, in Decimal, quantised to the resolution the ledger stores.

WHY DECIMAL AND WHY 8 dp. A typical insights call on Qwen3-32B (~2000 in, ~400
out) costs $0.000272. Rounded to cents that is $0.00, and every DeepInfra row in
ai_calls would read zero -- destroying the one thing the table exists to show,
which is that the cheap provider is cheaper. One DeepInfra input token is
$0.00000008, exactly the resolution of numeric(12,8). And these values get
SUM()ed over a month and compared against an invoice: Postgres sums numeric
exactly, while ten thousand float 2.72e-4 values accumulate error.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from services.ai.model_config import DEFAULT_ANTHROPIC_MODEL

_MTOK = Decimal(1_000_000)
_RESOLUTION = Decimal("0.00000001")  # 8 dp == numeric(12,8)

# Anthropic list prices, USD per million tokens. Checked 2026-08-25.
#
# Keyed by model and imported alongside DEFAULT_ANTHROPIC_MODEL rather than
# duplicating that id here, so a model migration stays a one-line change in
# services/ai/model_config.py -- the file that exists to be the single source of
# truth for the pinned model after the claude-sonnet-4-20250514 retirement.
ANTHROPIC_PRICES: dict[str, tuple[Decimal, Decimal]] = {
    "claude-sonnet-4-6": (Decimal("3.00"), Decimal("15.00")),
    "claude-opus-4-6": (Decimal("5.00"), Decimal("25.00")),
    "claude-haiku-4-5": (Decimal("1.00"), Decimal("5.00")),
}

# DeepInfra, USD per million tokens. Eval harness and emergency toggle only --
# this provider never enters a production chain.
DEEPINFRA_PRICES: dict[str, tuple[Decimal, Decimal]] = {
    "Qwen/Qwen3-32B": (Decimal("0.08"), Decimal("0.28")),
}


def _as_decimal(price: Decimal | float | int | str) -> Decimal:
    """Normalise a price to Decimal without going through binary float.

    Decimal(0.08) is 0.08000000000000000166533453693773481063544750213623046875.
    The registry declares prices as strings, but OpenAICompatProvider's signature
    takes plain numbers and invites a float literal at the call site, so every
    price is laundered through str() on the way in.
    """
    if isinstance(price, Decimal):
        return price
    return Decimal(str(price))


def estimate_cost_usd(
    tokens_in: int,
    tokens_out: int,
    price_in_per_mtok: Decimal | float | int | str,
    price_out_per_mtok: Decimal | float | int | str,
) -> Decimal:
    """Estimated USD cost of one call, quantised to 8 dp.

    "Estimated" is honest rather than modest: it uses list prices and ignores
    prompt caching, batch discounts and negotiated rates. It is a comparison
    number between providers and a sanity check against an invoice, not the
    invoice itself.
    """
    total = (
        Decimal(tokens_in) * _as_decimal(price_in_per_mtok)
        + Decimal(tokens_out) * _as_decimal(price_out_per_mtok)
    ) / _MTOK
    return total.quantize(_RESOLUTION, rounding=ROUND_HALF_UP)


def anthropic_prices(model: str) -> tuple[Decimal, Decimal]:
    """Prices for an Anthropic model, or raise.

    Deliberately raises rather than defaulting to zero. Shipping a model whose
    price is unknown would write est_cost_usd = 0 on every Anthropic call
    forever, and a ledger that silently reports a paid provider as free is worse
    than one that refuses to start.
    """
    try:
        return ANTHROPIC_PRICES[model]
    except KeyError:
        raise KeyError(
            f"No price on file for Anthropic model {model!r}. Add it to "
            f"ANTHROPIC_PRICES (services/llm/pricing.py) in the same change that "
            f"pins the model, or every call it serves is logged as free. "
            f"Currently pinned: {DEFAULT_ANTHROPIC_MODEL}."
        ) from None


__all__ = [
    "ANTHROPIC_PRICES",
    "DEEPINFRA_PRICES",
    "anthropic_prices",
    "estimate_cost_usd",
]
