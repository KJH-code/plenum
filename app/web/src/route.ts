import { useEffect, useState } from 'react';

// 해시 라우팅: #/ · #/project/<id> · #/settings/<분류>
export type Route = { page: 'home' } | { page: 'project'; id: string } | { page: 'settings'; cat: string };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'project' && parts[1]) return { page: 'project', id: parts[1] };
  if (parts[0] === 'settings') return { page: 'settings', cat: parts[1] || 'workers' };
  return { page: 'home' };
}

export function useRoute(): Route {
  const [r, setR] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setR(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export const href = {
  home: '#/',
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  settings: (cat: string) => `#/settings/${cat}`,
};
