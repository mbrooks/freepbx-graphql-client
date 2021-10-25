const nodeFetch = require("node-fetch");
const { GraphQLClient, gql } = require("graphql-request");

const defaultOptions = {
  debug: false,
  retry: 3,
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
  #options;
  #gqlAccessToken;
  #gqlClient;

  constructor(baseUrl, oAuthClientId, oAuthClientSecret, options = {}) {
    this.#oAuthClientId = oAuthClientId;
    this.#oAuthClientSecret = oAuthClientSecret;
    this.#oAuthEndpoint = getOAuthEndpoint(baseUrl);
    this.#gqlEndpoint = getGqlEndpoint(baseUrl);
    this.#options = { ...defaultOptions, ...options };
  }

  logError(message, err) {
    if (this.#options.debug) {
      console.error(message, err);
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
        this.logError("Caught GraphQL Error, Retrying:", err);
        await delay(retryDelay);
        return this.authenticateRequestWithRetry(retries - 1, retryDelay * 2);
      }

      throw err;
    });
  }

  async authenticate() {
    const retries = this.#options.retry;
    const retryDelay = this.#options.retryDelay;
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
        this.logError("Caught GraphQL Error, Retrying:", err);
        await delay(retryDelay);
        return this.requestWithRetry(retries - 1, retryDelay * 2, ...args);
      }

      // If access denied, try to reauthenticate immediately. Do not add any delay
      if (retries > 0 && err.response && err.response.status === 401) {
        this.logError("Caught GraphQL Error, Retrying:", err);
        this.#gqlAccessToken = null;
        this.#gqlClient = null;
        return this.requestWithRetry(retries - 1, retryDelay, ...args);
      }

      throw err;
    });
  }

  async request(...args) {
    const retries = this.#options.retry;
    const retryDelay = this.#options.retryDelay;
    return this.requestWithRetry(retries, retryDelay, ...args);
  }
}

module.exports = {
  FreepbxGqlClient,
  gql,
};
