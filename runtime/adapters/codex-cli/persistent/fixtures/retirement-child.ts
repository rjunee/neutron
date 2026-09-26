#!/usr/bin/env bun
// Disposable app-server-shaped process for exact exit receipt controls.
process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 40) })
console.log(JSON.stringify({ method: 'fixture/ready' }))
setInterval(() => {}, 1000)
