'use strict';
/** Escapes LIKE wildcards so user input is matched literally. */
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
module.exports = { escapeLike };
