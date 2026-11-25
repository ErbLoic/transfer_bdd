# RelayDB

Outil local pour copier des tables d'une base relationnelle vers une autre, quel que soit le moteur : structure, données, contraintes, avec anonymisation, simulation, vérification et historique chiffré.

Interface React (Vite) et API Express, lancées avec Docker.

## Lancer avec Docker

1. Créer le fichier `.env` à partir de `.env.example` et y renseigner une clé de chiffrement :

   ```bash
   openssl rand -base64 48
   ```

   Copier la valeur dans `RELAYDB_SECRET_KEY=`. Ce fichier n'est jamais commité. Sauvegardez la clé ailleurs : si elle est perdue ou changée, l'historique devient illisible. Sans clé, l'outil fonctionne, mais rien n'est enregistré.

2. Construire et démarrer :

   ```bash
   docker compose up --build
   ```

L'interface est disponible sur `http://relaydb.localhost` (via Laragon) ou `http://localhost:5173`. Pour arrêter : `docker compose down`.

Si une base tourne directement sur la machine Windows, utilisez `host.docker.internal` à la place de `localhost` dans la chaîne de connexion.

## Moteurs pris en charge

Source et cible peuvent être de n'importe quel type, dans tous les sens :

| Moteur | Format de chaîne de connexion |
|---|---|
| MySQL / MariaDB | `mysql://user:password@hote:3306/base` ou `mariadb://…` |
| PostgreSQL | `postgresql://user:password@hote:5432/base` (ajouter `?sslmode=require` pour Supabase) |
| SQL Server | `sqlserver://user:password@hote:1433/base` (ajouter `?trustServerCertificate=true` pour un serveur local sans certificat) |
| Oracle | `oracle://user:password@hote:1521/SERVICE` |
| SQLite | `sqlite:///data/fichier.db` (le fichier doit être placé dans le dossier `data/` du projet) |

**Autre schéma** : ajouter `?schema=nom` (PostgreSQL, SQL Server, Oracle). Pour MySQL, le schéma est la base indiquée dans l'URL.

## Fonctionnement

1. **Inspecter** la source : tables, nombre de lignes et colonnes.
2. **Choisir** les tables et, si besoin, le traitement de chaque colonne (voir Anonymisation).
3. **Simuler** : affiche le SQL qui serait exécuté et le nombre de lignes concernées, sans rien écrire.
4. **Lancer** : une barre de progression suit la copie, qui peut être annulée à tout moment.
5. **Vérifier** : à l'arrivée, chaque table est relue des deux côtés et comparée (nombre de lignes et empreinte du contenu). Le résultat est indiqué table par table.

### Ce qui est recréé dans la cible

- les **types de colonnes**, convertis automatiquement d'un moteur à l'autre ;
- les **clés primaires** et les **auto-incréments** (le compteur repart après la plus grande valeur copiée) ;
- les **valeurs par défaut** : constantes, date et heure courantes. Une expression propre à un moteur, sans équivalent, est ignorée et signalée ;
- les **index** et **contraintes d'unicité**. Les index sur expression, partiels ou spécialisés (plein texte, GIN…) sont signalés et ignorés, de même qu'un index sur une colonne que le moteur cible ne sait pas indexer (texte illimité sous MySQL, SQL Server ou Oracle) ;
- les **contraintes CHECK**, seulement entre deux bases du même moteur (leur syntaxe n'est pas transposable) ;
- les **clés étrangères** entre tables sélectionnées, avec leurs règles `ON DELETE` / `ON UPDATE`. Une clé vers une table non sélectionnée ou une colonne exclue est signalée et ignorée.

Entre deux bases MySQL, la définition native de la table est reprise telle quelle (sauf si des colonnes sont exclues).

### Tables déjà présentes dans la cible

- **Erreur si elle existe** (par défaut) : rien n'est écrasé.
- **Remplacer** : la table est supprimée puis recréée.
- **Ajouter les lignes** : les lignes sont insérées dans la table existante, sur les colonnes communes.
- **Mettre à jour (clé primaire)** : une ligne de même clé primaire est remplacée, les autres sont ajoutées.

Pour une table existante conservée, ni index, ni clés étrangères, ni vérification ne sont appliqués : elle peut contenir d'autres lignes.

### Gestion des erreurs

- **Tout ou rien** (par défaut) : au moindre échec ou à l'annulation, tout est défait. PostgreSQL, SQL Server et SQLite utilisent une vraie transaction : même les tables remplacées sont restaurées. MySQL et Oracle valident chaque création de table automatiquement : les tables créées sont supprimées, mais une table remplacée, ou des lignes ajoutées à une table existante avant l'erreur, ne peuvent pas être restaurées. Le rapport le signale.
- **Continuer malgré les erreurs** : chaque table est copiée séparément. Une table en erreur est annulée (jamais à moitié remplie), les suivantes continuent, et le rapport liste les erreurs table par table, index par index et clé par clé.

### Gros volumes

Les tables sont lues et écrites par lots de 5 000 lignes, ordonnés sur la clé primaire : une table n'est jamais chargée entière en mémoire. **Une table sans clé primaire est lue d'un seul bloc**, car aucun ordre stable ne permet de la découper.

### Précision

Décimaux, grands entiers, dates et heures sont transmis sous forme de texte exact : aucun arrondi et aucune perte de microsecondes, sauf quand le moteur cible ne sait pas stocker la valeur :

- MySQL n'a pas de type « date-heure avec fuseau » : ces valeurs sont converties en UTC ;
- SQL Server limite les fractions de seconde à 7 chiffres, MySQL et PostgreSQL à 6 ;
- Oracle n'a ni booléen, ni JSON, ni heure seule : ils deviennent `NUMBER(1)`, `CLOB` et texte. Oracle confond aussi chaîne vide et `NULL` ;
- SQLite stocke les décimaux en texte pour ne perdre aucun chiffre.

La vérification tient compte de ces conversions : un booléen devenu `1`, un horodatage passé en UTC ou un décimal complété de zéros sont considérés comme identiques.

## Anonymisation

Chaque colonne peut être copiée telle quelle ou :

| Traitement | Effet |
|---|---|
| Exclure | la colonne n'est pas copiée |
| Vider (NULL) | la valeur est remplacée par `NULL` (la colonne devient facultative) |
| Hacher | empreinte HMAC-SHA256 : une même valeur donne toujours la même empreinte, jointures et unicité sont préservées |
| Masquer | premier caractère conservé, le reste remplacé par `*` |
| Valeur fictive | valeur réaliste selon le nom de la colonne (`user_…@example.invalid`, `06…`, `192.0.2.x`…), elle aussi stable |

Le bouton **Suggérer l'anonymisation** repère les colonnes au nom sensible (e-mail, téléphone, mot de passe, IP, nom, adresse…). Relisez toujours la proposition : elle se fonde sur les noms, pas sur le contenu.

La clé de hachage est tirée au hasard à chaque transfert et n'est jamais conservée : les valeurs d'origine ne peuvent pas être retrouvées. Une clé primaire ne peut être ni vidée ni exclue, elle est hachée à la place.

## Export et import de fichiers

- **JSON RelayDB** : structure et données des tables cochées, réimportable dans n'importe quelle base cible avec les mêmes options (ajout, mise à jour, vérification…).
- **Script SQL** : `CREATE TABLE`, `INSERT`, index et clés étrangères pour le moteur choisi.
- **CSV** : une seule table, en UTF-8 lisible par Excel.

L'anonymisation choisie s'applique aussi aux exports.

## Historique et profils

Chaque transfert, simulation ou import est enregistré avec ses paramètres, son rapport et sa durée. Depuis l'historique, on peut **revoir le rapport**, **réutiliser** les paramètres ou **supprimer** une entrée. Les chaînes de connexion peuvent aussi être enregistrées comme **profils**.

Ces données contiennent des identifiants. Elles sont stockées dans `data/relaydb-store.enc`, chiffrées en AES-256-GCM avec une clé dérivée de `RELAYDB_SECRET_KEY` (scrypt). Le fichier est illisible sans la clé, et toute modification est détectée. L'interface n'affiche que des chaînes masquées. Les 200 dernières entrées sont conservées.

L'API n'est exposée que sur `127.0.0.1` : n'ouvrez pas le port 5173 sur le réseau.

## Tests

```bash
npm test               # SQLite → SQLite, anonymisation, simulation, annulation, export/import, chiffrement
npm run test:engines   # chaîne entre vrais moteurs
```

`test:engines` utilise les moteurs dont la variable est définie : `RELAYDB_TEST_POSTGRES`, `RELAYDB_TEST_MYSQL`, `RELAYDB_TEST_MSSQL`, `RELAYDB_TEST_ORACLE` (chaînes de connexion vers des bases jetables). La CI GitHub (`.github/workflows/ci.yml`) démarre les quatre moteurs avec un mot de passe aléatoire et lance l'ensemble à chaque push.

## Licences des dépendances

`mssql` (MIT), `oracledb` (Apache-2.0 / UPL-1.0), `mysql2` (MIT), `pg` (MIT), `express` (MIT), `react` (MIT).
