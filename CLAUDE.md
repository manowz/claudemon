# Claudemon — instruções do projeto

Widget de desktop em Electron (JS puro, sem framework) que mostra o consumo da assinatura do Claude **e/ou** do OpenAI Codex (os dois podem ficar conectados ao mesmo tempo; uma setinha no dashboard alterna a IA exibida) com um Pokémon 8-bit. UI em `renderer/` (HTML/CSS/JS), processo principal em `main.js`, persistência/OAuth/usage em `src/` (Claude em `oauth.js`+`usage.js`, Codex em `codex.js`, contas por provedor em `config.js`). Idioma do projeto e da comunicação: **português (pt-BR)**.

## Comandos

- `npm start` — roda o app em desenvolvimento
- `npm run dist` — gera instalador + portátil do Windows em `dist/` (teste local)
- `npm run dist:mac` — gera o .dmg (só funciona em macOS)

## Ao finalizar uma feature nova (checklist de release)

Sempre que uma feature for concluída e testada, publique uma versão nova:

1. Suba a versão em `package.json` (semver: correção = patch, feature = minor).
2. Rode `npm run dist` e teste o instalador gerado em `dist/`.
3. Atualize o `README.md` se a feature mudar uso/configuração.
4. Commit + push na `main`.
5. Crie e envie a tag da versão — é ela que dispara o build/publicação:
   ```bash
   git tag v<versão>
   git push origin v<versão>
   ```
6. O GitHub Actions (`.github/workflows/release.yml`) compila Windows **e** macOS e publica os arquivos no Release automaticamente (~10 min). Confira em https://github.com/manowz/claudemon/releases

## Regras

- **Nunca** commitar executáveis/`dist/` no git — binários vão só no GitHub Release (o workflow anexa sozinho).
- Os nomes dos artefatos não têm versão no nome (`Claudemon-Setup.exe`, `Claudemon-Portable.exe`, `Claudemon.dmg`) de propósito: os links `releases/latest/download/...` do README dependem deles — não renomear.
- A janela tem altura fixa (`main.js` e `.shell` em `renderer/style.css` — os dois valores devem andar juntos). Se adicionar linhas na UI, verificar se nada estoura nas telas de dashboard e configurações.
- Endpoints de usage/OAuth não são API pública — se quebrar, ver "Avisos importantes" no README.
