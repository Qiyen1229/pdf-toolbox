try {
  var t = localStorage.getItem('theme') || 'dark';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch (e) { document.documentElement.classList.add('dark'); }
