# Fixture app

A tiny Node server used to test Speedpatrol. `/api/items` is the critical
path: it runs `work()` from `work.js` on every request. The home page loads the
items with a fetch, and the Settings link is a screen navigation.
