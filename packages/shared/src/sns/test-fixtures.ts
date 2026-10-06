/**
 * Test material for the SNS verifier — public halves only. An RSA-2048
 * certificate made with `openssl req -x509` for these tests (its private key
 * was deleted once it had signed), the public key `openssl x509 -pubkey` read
 * from it, and AWS's documented sample notification (SNS developer guide,
 * "Parsing message formats") signed with it, as SignatureVersion 1 and 2.
 * Nothing here is trusted anywhere: the verifier takes certificates only
 * from SNS's own host, and this one is served by the tests themselves.
 */

export const FIXTURE_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDhTCCAm2gAwIBAgIUBpGgDO2sCqwXWhBML6Vn+Ji9v40wDQYJKoZIhvcNAQEL
BQAwUjEbMBkGA1UECgwSTXlEb21haW5zSHViIHRlc3RzMTMwMQYDVQQDDCpTTlMg
dmVyaWZpZXIgZml4dHVyZSwgbm90IHRydXN0ZWQgYW55d2hlcmUwHhcNMjYxMDA2
MTgyMDMyWhcNMzYxMDAzMTgyMDMyWjBSMRswGQYDVQQKDBJNeURvbWFpbnNIdWIg
dGVzdHMxMzAxBgNVBAMMKlNOUyB2ZXJpZmllciBmaXh0dXJlLCBub3QgdHJ1c3Rl
ZCBhbnl3aGVyZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJvsoHQC
E/qy0IZ4F8fWooaRuxu2M01Qu7MNj7XkGi5VeJo9WtFFyjoaiAytSxq3u7wvX3L6
Ur8C0KYmK6vxlKW3m8JtF5OZg0P8i+75m8c9Cw8USHvdRbEcvfuFLsYtBBNt2K+l
Mj5OsSiUKF+mf7V2qHmHhuYZbJP1TscioCE1wzbr9Up6Wz5UDGQCKtV1685JwJH3
or9+8+QGevAr+DJ6lAHFqqbdZuh49Ty/XIEsVIAUuM3VJmfTxXSKmVvnhQj1flOQ
NcKfgyE/ek/WeOuyX/ZwcEFhljqwviK0dEzLZL675j5yTbLPdukPSlL5z3yP5QkX
BxIVjX1fWmU6tIcCAwEAAaNTMFEwHQYDVR0OBBYEFHyh/PWKrjfbr/ZzgZN+KwW1
wVKXMB8GA1UdIwQYMBaAFHyh/PWKrjfbr/ZzgZN+KwW1wVKXMA8GA1UdEwEB/wQF
MAMBAf8wDQYJKoZIhvcNAQELBQADggEBADVFjf+J4QCN+KbUc2NmNtmsobcdAJ9+
PcuUIKGQ755Dio2COQFkK2WtTotCGFwRJwvmfHmEDdHjqxQvn/wchHRxhCmORi3l
5AJ8hhJ0WeX5eege1zGtt1b2H3WKjf3jm7KmKwUT7Mgvk+pYBVdZvG34gUt7t0pv
jGok4qd5qIFfyFeQdYWwwZsA8eaAJQZbamgsdaosW0MU1F0OwBizdW2/gaGMM/ie
fywNoTHjQ5J2rrBLc3Tgx5TfYb0BteaSct62sSWuSMalNxVrj1Fp6J/Mx4y6+YZx
7PCIAUHEigVgPtu81AZq9xa6b/3zQWHiPjOdr5s/6WwuLS5KdJ34DRA=
-----END CERTIFICATE-----
`

export const FIXTURE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAm+ygdAIT+rLQhngXx9ai
hpG7G7YzTVC7sw2PteQaLlV4mj1a0UXKOhqIDK1LGre7vC9fcvpSvwLQpiYrq/GU
pbebwm0Xk5mDQ/yL7vmbxz0LDxRIe91FsRy9+4Uuxi0EE23Yr6UyPk6xKJQoX6Z/
tXaoeYeG5hlsk/VOxyKgITXDNuv1SnpbPlQMZAIq1XXrzknAkfeiv37z5AZ68Cv4
MnqUAcWqpt1m6Hj1PL9cgSxUgBS4zdUmZ9PFdIqZW+eFCPV+U5A1wp+DIT96T9Z4
67Jf9nBwQWGWOrC+IrR0TMtkvrvmPnJNss926Q9KUvnPfI/lCRcHEhWNfV9aZTq0
hwIDAQAB
-----END PUBLIC KEY-----
`

/** The sample from AWS's documentation, on its own topic and certificate URL. */
export const AWS_SAMPLE_NOTIFICATION = {
  Type: 'Notification',
  MessageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324',
  TopicArn: 'arn:aws:sns:us-west-2:123456789012:MyTopic',
  Subject: 'My First Message',
  Message: 'Hello world!',
  Timestamp: '2012-05-02T00:54:06.655Z',
  SigningCertURL:
    'https://sns.us-west-2.amazonaws.com/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem',
  UnsubscribeURL:
    'https://sns.us-west-2.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:us-west-2:123456789012:MyTopic:c9135db0-26c4-47ec-8998-413945fb5a96',
} as const

/** `openssl dgst -sha1 -sign` over the sample's string to sign. */
export const AWS_SAMPLE_SIGNATURE_V1 =
  'lrJmYkzm5Z3Ls2GhHEtt7dZX7dY0gIDQ1zo67ZrjCQ5Yjuxl86ikFMeLos9ygjkUTsrU7ogkOKAx6hpBQ3LY/jyruUtb/3Wqzv/Z8E+8RhQ6b/DO7xIvu6FSDDGdHMOv6n2YMenrIihUURzh4VLRKD6+frgnAg9I33+fzbRF3Rg94NFeGjhlEsXeYSFkDkK1SIlNJHM6IJQYny3CzLHSCSZrhnCHF7OGnUCJgA/wYwaIcVb/M9e3owf4fKn5flVAYdYwV4lOgA0sMh5jTOQrd3YBFKVNzMqTihJ/KoWEZj0pjHNK9oM7StHLZTSA3/3xWoT04RT0pispmjDo/+LmsQ=='

/** `openssl dgst -sha256 -sign` over the same. */
export const AWS_SAMPLE_SIGNATURE_V2 =
  'Ul4UaSm38ZeQdL5tzPK+9qIYGbkzUTiJWvA0UaXL468jjjeAkDigxQgcGiPZwDmTIadBiynzkwBJv1Z821PbghSyLA71tT+KalRZd9q/DoKERp6fcJu7nQvdttP0lxZJIXqbKhExwKbnz7pZYXVL67k53niwwSfMbG96Gvvg9uj5u99VU3a/IeR26UtNWkwZfR5JIVk7nFV59oNhwl3aTdWVroNmUMD62BCVSnSOUOcKoiGWqE3njg3e1MCfQaxOELV+JZHptyvIlR1trHmbPj8qM3Tpb0pWRbB8rB6kiS02cmZaFcOjd4Bi/Vq/aoFZDpWW4ouQdvRzf2fht5ZUGQ=='
