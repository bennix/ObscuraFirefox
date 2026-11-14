const engines = {
  google: { name: 'Google', template: 'https://www.google.com/search?q={query}' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q={query}' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={query}' },
  baidu: { name: '百度', template: 'https://www.baidu.com/s?wd={query}' },
  yahoo: { name: 'Yahoo', template: 'https://search.yahoo.com/search?p={query}' },
  brave: { name: 'Brave Search', template: 'https://search.brave.com/search?q={query}' }
};
function searchURL(query, engine = 'google') {
  return (engines[engine] || engines.google).template.replace('{query}', encodeURIComponent(String(query).trim()));
}
function destination(input, engine = 'google') {
  const value = String(input).trim();
  if (!value) throw new Error('请输入网址或搜索内容');
  if (/^https?:\/\//i.test(value)) return new URL(value).href;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(javascript|data|file|about):/i.test(value)) throw new Error('仅支持 HTTP 或 HTTPS 网页');
  const hostname = /^(localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(value);
  if (!/\s/.test(value) && hostname) return new URL((/^(localhost|127\.0\.0\.1|\[::1\])(?::|[/?#]|$)/.test(value) ? 'http://' : 'https://') + value).href;
  return searchURL(value, engine);
}
module.exports = { engines, destination, searchURL };
