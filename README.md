# React + Vite

## Lancer avec Docker

Construire et démarrer l'application :

```bash
docker compose up --build
```

L'interface est ensuite disponible sur `http://relaydb.localhost` ou `http://localhost:5173`.

Pour utiliser un autre nom local, par exemple `relaydb.test`, ajoute cette ligne dans `C:\Windows\System32\drivers\etc\hosts` (avec les droits administrateur) :

```text
127.0.0.1 relaydb.test
```

Puis remplace `relaydb.localhost` par `relaydb.test` dans `nginx.conf` et reconstruis le conteneur :

```bash
docker compose up -d --build
```

Pour arrêter les conteneurs :

```bash
docker compose down
```

Les chaînes de connexion aux bases sont saisies dans l'interface. Si une base tourne directement sur la machine Windows hôte, utilisez `host.docker.internal` à la place de `localhost`, par exemple :

```text
postgresql://user:password@host.docker.internal:5432/my_database
```

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
