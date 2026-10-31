// Two screens: Home, and Items, which renders a list each time it opens, so
// that screen navigation has some work for Speedpatrol to time.
const screens = { home: document.getElementById('home'), items: document.getElementById('items') };

function show(name) {
  for (const [key, screen] of Object.entries(screens)) screen.hidden = key !== name;
  if (name === 'items') {
    const list = document.createElement('ul');
    list.id = 'item-list';
    for (let i = 0; i < 2000; i++) {
      const item = document.createElement('li');
      item.textContent = `Item ${i + 1}`;
      list.append(item);
    }
    screens.items.replaceChildren(list);
  }
}

document.getElementById('nav-home').addEventListener('click', () => show('home'));
document.getElementById('nav-items').addEventListener('click', () => show('items'));
