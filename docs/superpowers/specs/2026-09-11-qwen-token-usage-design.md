# Qwen Token Plan Usage Extension Design

## Goal

Show current Qwen Cloud personal token plan usage in Pi's footer status area.

## Scope

The extension reads authentication from the `QWEN_COOKIE` environment variable. It reports the rolling five-hour and weekly percentages returned by Qwen Cloud. It does not fetch subscription metadata, credit limits, or browser cookies.

## Architecture

Create one auto-discovered Pi extension at `extensions/qwen-token-usage.ts`. The extension uses Node's built-in `fetch` and Pi's `ctx.ui.setStatus`; it adds no runtime dependencies.

The extension starts one refresh cycle on `session_start` and repeats it every 60 seconds. It clears the timer and footer status on `session_shutdown`.

## Data Flow

1. Read `QWEN_COOKIE` from the process environment.
2. Send the cookie to `GET https://home.qwencloud.com/tool/user/info.json` and parse `data.secToken`.
3. Build an `application/x-www-form-urlencoded` request for the Qwen personal usage API.
4. Send the request to `POST https://cs-data.qwencloud.com/data/api.json` using the usage endpoint described by CodexBar PR 2329.
5. Parse `data.DataV2.data.data.per5HourPercentage` and `per1WeekPercentage`.
6. Convert each fraction from the API into a percentage and render `Qwen 5h 12% · week 4%` through `ctx.ui.setStatus`.

Refreshes must not overlap. A slow request is allowed to finish before another refresh starts.

## Error Handling

When `QWEN_COOKIE` is absent, show `Qwen: auth required`. When authentication fails or the expected payload is absent, show `Qwen: unavailable`. Never log or display the cookie or security token. Network failures remain contained within the refresh cycle and do not affect Pi.

## Testing

Add a focused parser test that verifies envelope parsing and conversion from fractional values to displayed percentages. Keep request construction testable in the same module without introducing client classes or mocks.

## Non-Goals

- Browser cookie import
- Subscription tier and status
- Absolute credit usage or plan ceilings
- Commands or configuration files
- Widgets above the editor
