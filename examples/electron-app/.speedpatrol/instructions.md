# electron-app

A two-screen Electron app: Home, and Items, which renders a list of 2,000 rows
each time it opens. The renderer is `renderer.js`; the main process is `main.js`.

Critical paths: the cold launch to the Home screen, and moving between Home and
Items in a running window.
