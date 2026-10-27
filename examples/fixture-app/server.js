import { createServer } from 'node:http';
import { work } from './work.js';

const port = Number(process.env.PORT ?? 4390);

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:2rem}nav a{margin-right:1rem}.card{padding:1rem;border:1px solid #ccc;margin:.5rem 0}</style>
</head><body><nav><a href="/" id="home">Home</a><a href="/settings" id="settings">Settings</a></nav>${body}</body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  if (url.pathname === '/api/items') {
    const checksum = work();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item ${i}` })), checksum }),
    );
    return;
  }
  if (url.pathname === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/settings') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page('Settings', '<h1 id="settings-title">Settings</h1><div class="card">Notifications</div>'));
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      page(
        'Home',
        `<h1>Fixture app</h1><ul id="items"></ul><script type="module">
          const res = await fetch('/api/items');
          const { items } = await res.json();
          document.getElementById('items').innerHTML = items.map((i) => '<li class="card">' + i.name + '</li>').join('');
        </script>`,
      ),
    );
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, '127.0.0.1', () => console.log(`fixture listening on ${port}`));
