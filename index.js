const nodeFetch = require("node-fetch");
const { GraphQLClient, gql } = require("graphql-request");

const defaultConfig = {
  debug: false,
  retry: 5,
  retryDelay: 1000,
};

// Define network connection errors
const connectionErrors = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
];

const getOAuthEndpoint = (baseUrl) => {
  return `${baseUrl}/admin/api/api/token`;
};

const getGqlEndpoint = (baseUrl) => {
  return `${baseUrl}/admin/api/api/gql`;
};

// Utility function to make application wait the specified milliseconds
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FreepbxGqlClient {
  #oAuthClientId;
  #oAuthClientSecret;
  #oAuthEndpoint;
  #gqlEndpoint;
  #config;
  #gqlAccessToken;
  #gqlClient;

  constructor(baseUrl, config = {}) {
    if (!config.client) {
      throw new Error("Missing client configuration");
    }

    if (!config.client.id) {
      throw new Error("Missing client id");
    }

    if (!config.client.secret) {
      throw new Error("Missing client secret");
    }

    this.#oAuthClientId = config.client.id;
    this.#oAuthClientSecret = config.client.secret;
    this.#oAuthEndpoint = getOAuthEndpoint(baseUrl);
    this.#gqlEndpoint = getGqlEndpoint(baseUrl);
    this.#config = { ...defaultConfig, ...config };
  }

  logDebug(...args) {
    if (this.#config.debug) {
      console.log(...args);
    }
  }

  retryNetworkError(err) {
    if (err.code && connectionErrors.includes(err.code)) {
      return true;
    }

    if (err.message === "Client request timeout") {
      return true;
    }

    return false;
  }

  async authenticateRequestWithRetry(retries, retryDelay) {
    const oAuthParams = new URLSearchParams();
    oAuthParams.append("grant_type", "client_credentials");
    oAuthParams.append("client_id", this.#oAuthClientId);
    oAuthParams.append("client_secret", this.#oAuthClientSecret);

    return nodeFetch(this.#oAuthEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: oAuthParams,
    }).catch(async (err) => {
      // retry request on network error
      if (retries > 0 && this.retryNetworkError(err)) {
        this.logDebug("Caught GraphQL Error, Retrying:", err);
        await delay(retryDelay);
        return this.authenticateRequestWithRetry(retries - 1, retryDelay * 2);
      }

      throw err;
    });
  }

  async authenticate() {
    const retries = this.#config.retry;
    const retryDelay = this.#config.retryDelay;
    const authResult = await this.authenticateRequestWithRetry(
      retries,
      retryDelay
    );
    if (authResult.status !== 200) {
      throw new Error("Authentication Failed");
    }

    const { access_token: accessToken } = await authResult.json();
    this.#gqlAccessToken = accessToken;
    return accessToken;
  }

  async buildClient() {
    if (this.#gqlClient) {
      return;
    }

    if (!this.#gqlAccessToken) {
      await this.authenticate();
    }

    const gqlClient = new GraphQLClient(this.#gqlEndpoint);
    gqlClient.setHeader("Authorization", "Bearer " + this.#gqlAccessToken);
    this.#gqlClient = gqlClient;
  }

  async requestWithRetry(retries, retryDelay, ...args) {
    await this.buildClient();
    return this.#gqlClient.request(...args).catch(async (err) => {
      // retry request on network error
      if (retries > 0 && this.retryNetworkError(err)) {
        this.logDebug("Caught GraphQL Error, Retrying:", err);
        await delay(retryDelay);
        return this.requestWithRetry(retries - 1, retryDelay * 2, ...args);
      }

      // If access denied, let's assume the access token has expired. Clear the
      // access token and force a reauthentication. Do not add any delay
      if (retries > 0 && err.response && err.response.status === 401) {
        this.logDebug("Caught GraphQL Error, Retrying:", err);
        this.#gqlAccessToken = null;
        this.#gqlClient = null;
        return this.requestWithRetry(retries - 1, retryDelay, ...args);
      }

      throw err;
    });
  }

  async request(...args) {
    const retries = this.#config.retry;
    const retryDelay = this.#config.retryDelay;
    return this.requestWithRetry(retries, retryDelay, ...args);
  }

  async fetchTransactionStatus(transactionId) {
    const query = gql`
      query FetchApiStatus($transactionId: ID!) {
        fetchApiStatus(txnId: $transactionId) {
          status
          message
        }
      }
    `;

    const variables = {
      transactionId,
    };

    return this.request(query, variables);
  }

  async waitForTransactionSuccess(
    transactionId,
    retries = 300,
    retryDelay = 1000
  ) {
    this.logDebug(`Waiting for transaction ${transactionId} to completed`);

    const data = await this.fetchTransactionStatus(transactionId);

    // If a corrupted response is received, let's just Fetch the API Status again
    // and pretend this didn't happen
    if (!data || !data.fetchApiStatus) {
      this.logDebug("Received Invalid Response", { data });
      await delay(retryDelay);
      return this.waitForTransactionSuccess(
        transactionId,
        retries - 1,
        retryDelay
      );
    }

    // Transaction completed successfully, return the result
    if (
      data.fetchApiStatus.status === true &&
      data.fetchApiStatus.message === "Executed"
    ) {
      return data;
    }

    // Transaction is still processing, wait for the transaction to complete
    if (
      retries > 0 &&
      data.fetchApiStatus.status === true &&
      data.fetchApiStatus.message === "Processing"
    ) {
      await delay(retryDelay);
      return this.waitForTransactionSuccess(
        transactionId,
        retries - 1,
        retryDelay
      );
    }

    // Transaction failed, throw an error
    if (
      data.fetchApiStatus.status === false ||
      data.fetchApiStatus.message !== "Processing"
    ) {
      const err = new Error("Transaction failed");
      err.results = data;
      throw err;
    }

    // Transaction timeout waiting on a response
    const err = new Error("Timeout waiting on transaction to complete");
    err.results = data;
    throw err;
  }

  async requestTransactionAndWait(
    query,
    variables,
    retries = 300,
    retryDelay = 1000
  ) {
    return this.request(query, variables).then((queryResponse) => {
      const transStartObj = queryResponse[Object.keys(queryResponse)[0]];
      return this.waitForTransactionSuccess(
        transStartObj.transaction_id,
        retries,
        retryDelay
      );
    });
  }
}

module.exports = {
  FreepbxGqlClient,
  gql,
};
