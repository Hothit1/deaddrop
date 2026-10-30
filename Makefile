.PHONY: all build test test-contract test-e2e demo demo-testnet web install

all: test

install:
	cd sim && npm ci

build:
	cd contract && cargo near build non-reproducible-wasm

test-contract:
	cd contract && cargo test

test-e2e: build install
	cd sim && npm test

test: test-contract test-e2e

demo: build install
	cd sim && npm run demo

demo-testnet: build install
	cd sim && npm run demo -- testnet

web:
	cd sim && npm run web
