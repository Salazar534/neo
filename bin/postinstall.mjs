#!/usr/bin/env node
/** postinstall — do NOT download models. Point users to neo install. */
console.log(`
  NEO installed. Next:

    neo install     # download model + brain runtime (~2GB)
    neo doctor      # verify
    neo             # start

  Docs: see README.md
`);
