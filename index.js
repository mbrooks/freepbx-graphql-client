const nodeFetch = require("node-fetch");
const { GraphQLClient, gql } = require("graphql-request");
const polly = require("polly-js");

const defaultOptions = {
  retry: 3,
  delay: 1000,
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

    polly.defaults.delay = this.#options.delay;
  }

  async handleRetry(fn) {
    return polly()
      .logger((err) => {
        console.error("Caught GraphQL Error, Retrying:", err);
      })
      .handle((err) => {
        if (err.code && connectionErrors.includes(err.code)) {
          return true;
        }

        if (err.message === "Client request timeout") {
          return true;
        }

        return false;
      })
      .waitAndRetry(this.#options.retry)
      .executeForPromise(() => {
        return fn;
      });
  }

  async getOAuthAccessToken() {
    if (this.#gqlAccessToken) {
      return this.#gqlAccessToken;
    }

    const oAuthParams = new URLSearchParams();
    oAuthParams.append("grant_type", "client_credentials");
    oAuthParams.append("client_id", this.#oAuthClientId);
    oAuthParams.append("client_secret", this.#oAuthClientSecret);

    const authResult = await nodeFetch(this.#oAuthEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: oAuthParams,
    });

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

    const accessToken = await this.handleRetry(this.getOAuthAccessToken());
    const requestHeaders = {
      headers: {
        Authorization: "Bearer " + accessToken,
      },
    };
    const gqlClient = new GraphQLClient(this.#gqlEndpoint, requestHeaders);
    this.#gqlClient = gqlClient;
  }

  async request(...args) {
    await this.buildClient();
    return this.handleRetry(this.#gqlClient.request(...args));
  }
}

module.exports = {
  FreepbxGqlClient,
  gql,
};
