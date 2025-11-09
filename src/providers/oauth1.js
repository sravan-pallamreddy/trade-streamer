const crypto = require('node:crypto');

function encodeRFC3986(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function toBaseString(method, baseURL, params) {
  const normUrl = baseURL.replace(/\?.*$/, '');
  const pairs = Object.keys(params)
    .sort()
    .map(k => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`)
    .join('&');
  return [method.toUpperCase(), encodeRFC3986(normUrl), encodeRFC3986(pairs)].join('&');
}

function signHmacSha1(baseString, consumerSecret, tokenSecret = '') {
  const key = `${encodeRFC3986(consumerSecret)}&${encodeRFC3986(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

function buildOAuthHeader({ method, url, query = {}, consumerKey, consumerSecret, token, tokenSecret, extra = {} }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (token) oauthParams.oauth_token = token;
  const allParams = { ...query, ...oauthParams, ...extra };
  const baseString = toBaseString(method, url, allParams);
  const signature = signHmacSha1(baseString, consumerSecret, tokenSecret);
  const headerParams = { ...oauthParams, ...extra, oauth_signature: signature };
  const header = 'OAuth ' + Object.keys(headerParams)
    .sort()
    .map(k => `${encodeRFC3986(k)}="${encodeRFC3986(headerParams[k])}"`)
    .join(', ');
  return header;
}

function buildOAuthParts(opts) {
  const { method, url, query = {}, consumerKey, consumerSecret, token, tokenSecret, extra = {} } = opts;
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (token) oauthParams.oauth_token = token;
  const allParams = { ...query, ...oauthParams, ...extra };
  const baseString = toBaseString(method, url, allParams);
  const signature = signHmacSha1(baseString, consumerSecret, tokenSecret);
  const headerParams = { ...oauthParams, ...extra, oauth_signature: signature };
  const header = 'OAuth ' + Object.keys(headerParams)
    .sort()
    .map(k => `${encodeRFC3986(k)}="${encodeRFC3986(headerParams[k])}"`)
    .join(', ');
  return { header, baseString, headerParams };
}

module.exports = { buildOAuthHeader, buildOAuthParts };
