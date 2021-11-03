# freepbx-graphql-client

A GraphQL client for FreePBX supporting Node

## Features

- Support for both oAuth and GraphQL out of the box
- Promise-based API (works with async / await)
- Automatic Reconnects
- Support for Long Running Transaction Tasks (Unique to FreePBX)
- Support for CommonJS scripts (CJS) and ESM scripts (aka MJS)

## Limitations

- Currently ONLY supports Machine-to-Machine oAuth. React and Angular unsupported
at this time
- Typescript unsupported at this time

## Install
```sh
	npm install --save freepbx-graphql-client
```

## Usage

### Basic Usage
This is a basic example of how to use the client.

```js
const { FreepbxGqlClient, gql } = require("freepbx-graphql-client");

const client = new FreepbxGqlClient("https://freepbx.hostname", {
	client: {
		id: "<client id>",
		secret: "<client secret>",
	}
});

const query = gql`
	query { 
		fetchHostname { 
			hostname
			frameworkVersion
		}
	}
`;
client.request(query).then((result) => console.log(result));
```

### Async/Await Usage
This is an example of how to use the client with async/await.

```js
const { FreepbxGqlClient, gql } = require("freepbx-graphql-client");

async function main() {
	const client = new FreepbxGqlClient("https://freepbx.hostname", {
		client: {
			id: "<client id>",
			secret: "<client secret>",
		},
	});

	const query = gql`
		query { 
			fetchHostname { 
				hostname
				frameworkVersion
			}
		}
	`;
	const result = await client.request(query);
	console.log(JSON.stringify(result, undefined, 2));
}

main().catch((error) => console.error(error));
```

### Using Transaction
FreePBX GraphQL API supports transactions. This is an example of how to use the
client with transactions. Once the query is executed, the client waits on the
transaction to finish before resolving the promise and continuing.

Note: The status, message, and transaction_id query fields are required when
using transactions.

```js
const { FreepbxGqlClient, gql } = require("freepbx-graphql-client");

async function main() {
	const client = new FreepbxGqlClient("https://freepbx.hostname", {
		client: {
			id: "<client id>",
			secret: "<client secret>",
		},
	});

	const query = gql`
		mutation {
			upgradeAllModules(input: {}) {
				status
				message
				transaction_id
			}
		}
	`;
	const result = await client.requestTransactionAndWait(query);
	console.log(JSON.stringify(result, undefined, 2));
}

main().catch((error) => console.error(error));
```

### Using GraphQL Document variables
It is possible to pass variables to the GraphQL document. This format should be
used to properly escape any variables to protect the query from GraphQL-injection
attacks.

```js
const { FreepbxGqlClient, gql } = require("freepbx-graphql-client");

async function main() {
	const client = new FreepbxGqlClient("https://freepbx.hostname", {
		client: {
			id: "<client id>",
			secret: "<client secret>",
		},
	});

	const query = gql`
		mutation doActivateSystem($deploymentId: String!) {
			activateSystem(input: { deploymentId: $deploymentId }) {
				status
				message
				transaction_id
			}
		}
	`;

	const variables = {
		deploymentId: '123456789',
	};

	const result = await client.requestTransactionAndWait(query, variables);
	console.log(JSON.stringify(result, undefined, 2));
}

main().catch((error) => console.error(error));
```

### ESM/MJS support
This is an example of how to use the client with ESM scripts (aka MJS).

```js
import { FreepbxGqlClient, gql } from 'freepbx-graphql-client'

async function main() {
	const client = new FreepbxGqlClient("https://freepbx.hostname", {
		client: {
			id: "<client id>",
			secret: "<client secret>",
		},
	});

	const query = gql`
		query { 
			fetchHostname { 
				hostname
				frameworkVersion
			}
		}
	`;
	const result = await client.request(query);
	console.log(JSON.stringify(result, undefined, 2));
}

main().catch((error) => console.error(error));
```