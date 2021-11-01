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

/**
 * Return the oAuth endpoint given the baseUrl
 * @param  {string} baseUrl
 * @returns {string}
 */
const getOAuthEndpoint = (baseUrl) => {
  return `${baseUrl}/admin/api/api/token`;
};

/**
 * Return the GraphQL endpoint given the baseUrl
 * @param  {string} baseUrl
 * @returns {string}
 */
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

  /**
   * Helper function to log a debug message if debug is enabled
   * @param  {args} ...args
   */
  logDebug(...args) {
    if (this.#config.debug) {
      console.log(...args);
    }
  }

  /**
   * Helper function that can identify if a given error is a network error
   * @param  {Error} err
   * @returns {boolean}
   */
  retryNetworkError(err) {
    if (err.code && connectionErrors.includes(err.code)) {
      return true;
    }

    if (err.message === "Client request timeout") {
      return true;
    }

    return false;
  }

  /**
   * Helper function to send the authentication request. Typically used by
   * the authenticate() method to handle retries.
   * @param  {number} retries
   * @param  {number} retryDelay
   * @returns {Promise}
   */
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

  /**
   * Authenticate the client and set the access token
   * @returns {string}
   */
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

  /**
   * Authenticate and Build the GraphQL client. Typically used by requestWithRetry()
   */
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

  /**
   * Helper function to handle retry logic for request. Typicall used by request()
   * @param  {number} retries
   * @param  {number} retryDelay
   * @param  {string} query the GraphQL query to execute
   * @param  {object} variables the variables to pass to the GraphQL query
   * @returns {Promise}
   */
  async requestWithRetry(retries, retryDelay, query, variables) {
    await this.buildClient();
    return this.#gqlClient.request(query, variables).catch(async (err) => {
      // retry request on network error
      if (retries > 0 && this.retryNetworkError(err)) {
        this.logDebug("Caught GraphQL Error, Retrying:", err);
        await delay(retryDelay);
        return this.requestWithRetry(
          retries - 1,
          retryDelay * 2,
          query,
          variables
        );
      }

      // If access denied, let's assume the access token has expired. Clear the
      // access token and force a reauthentication. Do not add any delay
      if (retries > 0 && err.response && err.response.status === 401) {
        this.logDebug("Caught GraphQL Error, Retrying:", err);
        this.#gqlAccessToken = null;
        this.#gqlClient = null;
        return this.requestWithRetry(retries - 1, retryDelay, query, variables);
      }

      throw err;
    });
  }

  /**
   * Execute a Graphql query and return the result
   * @param  {string} query the GraphQL query to execute
   * @param  {object} variables the variables to pass to the GraphQL query
   * @returns {Promise}
   */
  async request(query, variables) {
    const retries = this.#config.retry;
    const retryDelay = this.#config.retryDelay;
    return this.requestWithRetry(retries, retryDelay, query, variables);
  }

  /**
   * Fetch the status of a transaction give an transaction id
   * @param  {sting} transactionId
   * @returns {Promise}
   */
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

  /**
   * Helper function that will wait for a transaction to complete given a transacton id
   * @param  {sting} transactionId
   * @param  {number} retries=300
   * @param  {number} retryDelay=1000
   *
   * @returns {Promise}
   */
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

  /**
   * Execute a FreePBX Transactional Graphql query, wait for the transaction to
   * complete, and return the result
   * @param  {string} query the GraphQL query to execute
   * @param  {object} variables the variables to pass to the GraphQL query
   * @param  {number} retries=300
   * @param  {number} retryDelay=1000
   * @returns {Promise}
   */
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
