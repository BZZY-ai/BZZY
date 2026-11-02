# WhatWeb 0.6.4 option reference

This reference condenses the WhatWeb 0.6.4 help supplied when this skill was
authored. Check the installed `whatweb --version` and `whatweb --help` before use;
the installed command is authoritative if options change.

## Targets and URL transformations

- Positional targets may be URLs, hostnames, IP addresses, filenames, CIDR
  ranges, short address ranges or explicit start-to-end IP ranges.
- `--input-file=FILE` / `-i FILE` reads targets from a file. Standard input can
  be selected with `-i /dev/stdin` when the runtime permits it.
- `--url-prefix=PREFIX` and `--url-suffix=SUFFIX` modify every target.
- `--url-pattern=PATTERN` inserts each target at `%insert%` in the pattern.

Preview transformations and range expansion before requests. A filename or
range being syntactically accepted does not establish authorization.

## Aggression

- `--aggression=1` / `-a 1`: one request per target, plus permitted redirects.
- `--aggression=3` / `-a 3`: plugins matched at level 1 may make follow-up
  requests.
- `--aggression=4` / `-a 4`: attempts URLs from all plugins and can make many
  requests.

The help does not define level 2. Do not invent it. Aggression controls request
behavior, not permission, stealth guarantees or confidence by itself.

## HTTP behavior

- `--user-agent=AGENT` / `-U AGENT` changes the user agent.
- `--header='Name: value'` / `-H 'Name: value'` adds or replaces a header. An
  empty value removes the default header.
- `--follow-redirect=WHEN` accepts `never`, `http-only`, `meta-only`,
  `same-site` or `always`. Version 0.6.4 defaults to `always`; override it to
  match scope.
- `--max-redirects=NUM` defaults to 10.

Use a truthful user agent when the program requires identification. Never alter
headers or identity to evade a control.

## Authentication and proxies

- `--user=USER:PASSWORD` / `-u USER:PASSWORD` supplies HTTP basic
  authentication.
- `--cookie=COOKIES` / `-c COOKIES` supplies cookie values.
- `--cookie-jar=FILE` reads cookies from a file and writes them back to it,
  creating the file when absent.
- `--no-cookies` disables automatic cookie handling.
- `--proxy=HOST[:PORT]` selects a proxy; the documented default port is 8080.
- `--proxy-user=USER:PASSWORD` supplies proxy credentials.

These flags describe capability, not safe secret transport. Do not place raw
secret values in model-visible input, shell history or logged process arguments.
Use only an approved private runtime mechanism; otherwise stop the authenticated
or credentialed portion of the scan.

## Plugins and matching

- `--list-plugins` / `-l` lists plugins.
- `--info-plugins[=SEARCH]` / `-I[=SEARCH]` displays detailed plugin information
  and may filter by comma-delimited keywords.
- `--search-plugins=STRING` searches for a plugin keyword.
- `--plugins=LIST` / `-p LIST` selects a comma-delimited plugin set. Entries may
  add or remove names, files or directories. `-p +` adds disabled plugins.
- `--grep=STRING_OR_REGEXP` / `-g STRING_OR_REGEXP` shows matching results.
- `--custom-plugin=DEFINITION` creates a custom match definition.
- `--dorks=PLUGIN` lists Google dorks for a plugin; it does not itself authorize
  using a search service or contacting discovered targets.

Built-in plugin names are preferable. External plugin files or directories are
executable content and require source review plus current execution permission.

## Output and logs

- `--verbose` / `-v` adds plugin descriptions; twice enables debugging detail.
- `--colour=never|always|auto` (also `--color`) controls terminal colour.
- `--quiet` / `-q` suppresses brief stdout logging.
- `--no-errors` suppresses error messages.
- File outputs include `--log-brief`, `--log-verbose`, `--log-errors`,
  `--log-xml`, `--log-json`, `--log-sql`, `--log-sql-create`,
  `--log-json-verbose`, `--log-magictree` and `--log-object`.
- MongoDB logging accepts database, collection, host, username and password
  options. The documented collection default is `whatweb` and host default is
  `0.0.0.0`.
- Elasticsearch logging accepts an index and host. The documented index default
  is `whatweb` and host default is `127.0.0.1:9200`.

Prefer a new local JSON file for portable analysis. Database logging is a
separate external side effect and requires explicit authorization, a configured
destination and private credential handling.

## Performance and stability

- `--max-threads=NUM` / `-t NUM` defaults to 25.
- `--open-timeout=SECONDS` defaults to 15.
- `--read-timeout=SECONDS` defaults to 30.
- `--wait=SECONDS` pauses between connections and is useful with one thread.
- `--output-sync` flushes output immediately and may be slower at high thread
  counts.
- `--output-buffer-size=SIZE` sets the output buffer; zero is unbuffered and the
  default is selected from the thread count.

Program limits override tool defaults. Lower concurrency before increasing
timeouts or retrying, and never use retries to defeat rate limiting.

## Help and diagnostics

- `--short-help`, `--help` / `-h`, and `--version` are local informational
  operations.
- `--debug` raises plugin errors and can expose more local detail. Use it only in
  an approved diagnostic context and review captured output before sharing.

Project homepage supplied with version 0.6.4 help:
<https://morningstarsecurity.com/research/whatweb>
