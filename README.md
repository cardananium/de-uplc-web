# de-uplc-web

UPLC debugger and decompiler in the browser: load a Plutus script or a
transaction, step through evaluation, inspect costs, or read the script back as
pseudocode.

**Live:** <https://cardananium.github.io/de-uplc-web/>

```bash
npm ci
npm run dev          # builds the WASM engines on first run, then serves the app
npm run build:web    # static bundle
npm test             # unit tests; `npm run e2e` for the headless browser checks
```

## License

[Apache 2.0](./LICENSE), provided **AS IS** with no warranty and no liability for
any use of it or its output — see [DISCLAIMER.md](./DISCLAIMER.md).
