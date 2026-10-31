# Electron app example

A small Electron app and a Speedpatrol config with the three ways to time a desktop app:

- `desktop.open` launches the app each iteration and times it to the first screen (an `electron` benchmark with `run`).
- `desktop.navigate` attaches to the window that `app.setup` started and times a screen journey (an `electron` benchmark without `run`). This is the shape to use when an e2e harness or a script owns the app's launch.
- `desktop.reload` reloads the running window and times it to `readySelector`.

```bash
cp -r examples/electron-app /tmp/electron-app && cd /tmp/electron-app
git init -q -b main && git add -A && git commit -qm "electron app"
npm install
npx speedpatrol run
```

On Linux with no screen, run `Xvfb :1 &` and `export DISPLAY=:1` first. If your app needs extra launch flags (for example `--no-sandbox` in a container), add them to both `electron` commands in `.speedpatrol/speedpatrol.yml`.
