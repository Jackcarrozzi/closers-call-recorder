const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function make(prefix) {
  const tag = prefix ? `[${prefix}] ` : '';
  return {
    info: (msg) => console.log(`${stamp()} ${tag}${msg}`),
    warn: (msg) => console.warn(`${stamp()} ${tag}WARN ${msg}`),
    error: (msg) => console.error(`${stamp()} ${tag}ERROR ${msg}`),
    child: (sub) => make(prefix ? `${prefix}:${sub}` : sub),
  };
}

export const logger = make('');
