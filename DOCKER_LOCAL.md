# RelayDB avec Docker en local

Ce document explique comment lancer RelayDB dans Docker et lui donner un nom de domaine local sur Windows.

## 1. Prerequis

- Docker Desktop installe et demarre
- PowerShell
- Le projet ouvert dans `C:\Users\lesha\Desktop\transfer_bdd`

Verifier Docker :

```powershell
docker --version
docker compose version
```

## 2. Demarrer l'application

Depuis le dossier du projet :

```powershell
docker compose up -d --build
```

Verifier l'etat des conteneurs :

```powershell
docker compose ps
```

Ouvrir l'application :

- http://relaydb.localhost
- http://localhost:5173

Arreter l'application :

```powershell
docker compose down
```

Afficher les logs :

```powershell
docker compose logs -f
```

## 3. Nom de domaine local recommande

`relaydb.localhost` est le nom recommande pour cet ordinateur. Les navigateurs reconnaissent automatiquement les domaines qui finissent par `.localhost` et les redirigent vers `127.0.0.1`.

Aucune modification du fichier `hosts` n'est necessaire pour ce nom.

Le nom est declare dans [nginx.conf](nginx.conf) :

```nginx
server_name relaydb.localhost relaydb.test;
```

## 4. Utiliser un domaine local personnalise

Pour utiliser `relaydb.test` sur cet ordinateur :

1. Ouvrir le Bloc-notes en administrateur.
2. Ouvrir le fichier :

   ```text
   C:\Windows\System32\drivers\etc\hosts
   ```

3. Ajouter :

   ```text
   127.0.0.1 relaydb.test
   ```

4. Reconstruire Nginx :

   ```powershell
   docker compose up -d --build
   ```

5. Ouvrir http://relaydb.test.

## 4 bis. Utiliser le domaine sans `:5173` avec Laragon

Si Laragon est demarre, son Apache occupe probablement le port 80. C'est pourquoi `http://relaydb.localhost` peut afficher Laravel au lieu de RelayDB.

Le fichier [laragon-relaydb.localhost.conf](laragon-relaydb.localhost.conf) est un VirtualHost Apache pret a l'emploi. Il faut :

1. Verifier que les modules Apache `proxy_module` et `proxy_http_module` sont actifs dans Laragon.
2. Copier le fichier dans :

   ```text
   C:\laragon\etc\apache2\sites-enabled\relaydb.localhost.conf
   ```

3. Redemarrer Apache depuis Laragon.
4. Ouvrir :

   ```text
   http://relaydb.localhost
   ```

Apache continuera de servir Laravel sur ses domaines habituels et transmettra `relaydb.localhost` vers Docker. Le port `5173` ne sera plus necessaire dans l'URL.

Alternative : arreter Apache/Laragon, puis publier directement Docker sur le port 80. Cette option rendrait Laravel indisponible sur le port 80 :

```yaml
ports:
  - "127.0.0.1:80:80"
```

Le fichier `hosts` ne concerne que cet ordinateur. Il ne cree pas un domaine public et ne demande pas de certificat DNS.

## 5. Autorisation reseau locale

Par defaut, Compose expose l'application uniquement sur `127.0.0.1:5173`. Cela signifie :

- accessible depuis cet ordinateur ;
- inaccessible depuis les autres ordinateurs du reseau ;
- aucune regle de pare-feu supplementaire necessaire.

Pour autoriser temporairement les autres appareils du reseau prive :

1. Dans `docker-compose.yml`, remplacer :

   ```yaml
   - "127.0.0.1:5173:80"
   ```

   par :

   ```yaml
   - "5173:80"
   ```

2. Trouver l'adresse IP locale du PC :

   ```powershell
   ipconfig
   ```

3. Ajouter une regle pare-feu PowerShell en administrateur :

   ```powershell
   New-NetFirewallRule -DisplayName "RelayDB Docker 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private
   ```

4. Depuis un autre appareil du reseau, utiliser :

   ```text
   http://ADRESSE_IP_DU_PC:5173
   ```

Pour supprimer cette autorisation :

```powershell
Remove-NetFirewallRule -DisplayName "RelayDB Docker 5173"
```

Pour utiliser le nom `relaydb.test` depuis un autre appareil, ajouter sur cet appareil une ligne dans son propre fichier `hosts` :

```text
ADRESSE_IP_DU_PC relaydb.test
```

N'ouvrez pas ce port sur le profil `Public` et ne faites pas de redirection de port Internet pour cette application sans ajouter une vraie authentification et HTTPS.

## 6. Connexion aux bases de donnees

L'API tourne dans le conteneur `api`. Dans une chaine de connexion saisie dans l'interface :

- une base dans un autre conteneur Docker utilise le nom du service, par exemple `postgresql://user:password@postgres:5432/database` ;
- une base installee directement sur Windows utilise `host.docker.internal` au lieu de `localhost` ;
- une base distante utilise son nom DNS ou son adresse IP habituelle.

Exemple pour PostgreSQL installe sur Windows :

```text
postgresql://user:password@host.docker.internal:5432/my_database
```

`localhost` dans le conteneur designe le conteneur lui-meme, pas Windows.

## 7. Architecture des conteneurs

- `frontend` : Nginx sert le build React sur le port local 5173.
- `api` : Node/Express ecoute sur le port interne 3001.
- Nginx transmet `/api/*` vers `http://api:3001`.
- L'API possede un endpoint de verification sur `/health`.
- Le frontend attend que l'API soit saine avant son demarrage Compose.

## 8. Depannage

Recreer les conteneurs apres une modification :

```powershell
docker compose down
docker compose up -d --build
```

Voir uniquement les logs de l'API :

```powershell
docker compose logs -f api
```

Verifier l'API depuis le reseau Docker :

```powershell
docker compose exec api node -e "fetch('http://localhost:3001/health').then(response => response.text()).then(console.log)"
```

Verifier que le nom local est resolu :

```powershell
Resolve-DnsName relaydb.localhost
Resolve-DnsName relaydb.test
```

Si `npm run dev` echoue avec un port deja utilise, arreter les conteneurs ou utiliser Docker seul :

```powershell
docker compose down
docker compose up -d
```
