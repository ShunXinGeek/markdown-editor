# Editor verification

Run npm ci, npx playwright install chromium firefox, and npm run test:release from the repository root. The suite builds dist, serves it with the generated CSP, and uses temporary browser profiles and local proxy fixtures.

Run node tests/benchmark.cjs markdown-editor.html to capture 30 input-handler samples after three warmups with a fixed 273890-character document. Set BENCH_CHROME to a local Chrome executable to use the same browser build before and after. Pass a measured baseline P95 as the second argument to require a reduction of at least 50%. The report also records the elapsed time from the last edit to the matching preview.

The release checks exercise both browser engines. DOCX structure and PDF page properties are checked with generated files. Public proxy calls use controlled test data. Local test results do not imply a deployment.
