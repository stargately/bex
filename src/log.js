// Tiny structured-ish logger. Keeps the gateway readable without a dep.
function ts() {
  return new Date().toISOString();
}

function emit(level, scope, msg, extra) {
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  process.stdout.write(`${ts()} ${level} [${scope}] ${msg}${tail}\n`);
}

export function logger(scope) {
  return {
    info: (msg, extra) => emit('INFO ', scope, msg, extra),
    warn: (msg, extra) => emit('WARN ', scope, msg, extra),
    error: (msg, extra) => emit('ERROR', scope, msg, extra),
  };
}
