Keycloak:
  - realm
    - default
  - client.id = apps
    - access.type = confidential
    - service.accounts = enabled
    - authorization.enabled = enabled
    - valid.redirect.uris = https://paste.kongeelabs.home.arpa/

Kong OIDC Plugin:
  - Config.Issuer = https://keycloak.kongeelabs.home.arpa/auth/realms/default
  - config.client.id = apps
  - config.client.secret = MqVfeqX3D8ivT30ScCIVa0eHhRu9VvFu
  - Config.Redirect Uri = https://paste.kongeelabs.home.arpa/
  - Config.Display Errors = check/true
