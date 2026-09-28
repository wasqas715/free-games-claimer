# Luna-era fix for Prime Gaming claim path

`prime-gaming.js` in this branch is a repaired build of the upstream script (upstream `main` at the
time of writing is byte-identical to the 2025-05-15 published image copy:
`a5bab1d3a5bc7848d5f993e8a189683d`, 27060 bytes, and still targets the pre-Luna markup).

## Why the stock script fails now

Amazon Prime Gaming migrated to `luna.amazon.com`, and four independent faults follow from it:

1. **Sign-in**: the visible email field is `input[name=email]`, but a hidden pre-rendered password
   field (`#ap-credential-autofill-hint`) makes `pwExists` true, so the password is attempted on the
   email page and Amazon answers "Wrong or Invalid email address or mobile phone number."
2. **Claim markup**: `[data-a-target="DescriptionItemDetails"]` and
   `[data-a-target="ClaimStateClaimCodeContent"]` are Twitch-era attributes that no longer exist.
   The code now lives in an **unnamed** `input[type="text"]` (no id, no name, no data attribute) on
   `luna.amazon.com/claims/<slug>/details`, and it renders a moment **after** the claim click - a
   ~4s settle is required or the read sees an empty page.
3. **Fatal racing promise**: the code read was an unguarded `Promise.any` with 60s timeouts. An
   already-claimed offer (no code element) throws `AggregateError`, which ended the entire external
   sweep at offer #1.
4. **Linking gate**: `div:has-text("Link account")` matches page boilerplate and aborts the redeem
   block, so key-bearing offers (microsoft, gog, legacy games) silently lose their codes. Store
   identity is also ambiguous: the offer URL slug and the page text disagreed in **both** directions
   on live offers (`-epic` slug but a Microsoft code; `-microsoft` slug but "epic games store" text).

## What this branch changes

- store identity keeps BOTH signals (URL slug + page text) and tests either against the redeem map,
  whose keys are exact strings (`'gog.com'`, `'microsoft store'`, `'legacy games'`)
- the linking text is evidence, not an abort; the redeem/code block always runs
- the code read is non-fatal: 4s settle, 15s timeouts, and a page-text scan fallback for the
  code shape when the selectors miss
- one bad offer can no longer end the sweep (per-offer `try`/`catch` + `continue`)
- claim diagnostics are tagged, so the log names which condition won
- claim status comes from the page's own marker (`Success, you received a code to redeem <game>.`,
  `Collected on <date>`) instead of an inference that recorded claimed offers as
  "failed: need account linking"

Verified end to end: external unclaimed went 13 -> 0, 15 offers claimed, clean `Exit 0`, and the
Microsoft plus two GOG keys were captured and reported.

## Known remaining

The in-game content phase (`PG_CLAIMDLC=1`) still waits on `button[data-type="InGameLoot"]`, another
Twitch-era attribute: it costs 60s per run and skips in-game loot (non-fatal). Not yet fixed.

## Rebuilding

`patches/` holds the patch chain and the builders used to produce this file, each of which syntax
checks, greps the build for instrumentation, installs, and verifies by hash:

    patch_prime_v5.py ... v10.py   one step per fault, chained from the previous verified payload
    build_and_run_prime_v*.sh      build -> gate -> install -> hash-verify -> run
    prime-gaming-orig.js           the pristine upstream copy this was derived from
