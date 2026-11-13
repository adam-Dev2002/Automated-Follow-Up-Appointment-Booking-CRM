# Local development

See [setup](docs/SETUP.md), [the user guide](USER-GUIDE.md), and [testing](TESTING-GUIDE.md).

The app serves http://localhost:3002 and proxies booking requests to local n8n. Overview booking references are browser-local; Calendar/Clients/booking balances read the protected shared source. Accounts, client photos, and transaction history are stored in private SQLite. Keep runtime data and n8n credentials outside Git.
