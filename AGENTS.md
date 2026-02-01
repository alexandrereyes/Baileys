# Baileys - Fork Instrumentado para Port C#

## Propósito deste Repositório

Este é um **fork instrumentado** do [Baileys](https://github.com/WhiskeySockets/Baileys) que serve exclusivamente como **suporte ao port para C#** (`/workspace/wwweb-csharp`). O código fonte do Baileys é a implementação de referência; este fork adiciona trace logging detalhado para permitir comparação lado a lado com o port C#.

**Este repositório NÃO é para desenvolvimento do Baileys em si.** Toda a lógica deve permanecer em sync com upstream.

- **Upstream**: https://github.com/WhiskeySockets/Baileys
- **Este fork**: https://github.com/alexandrereyes/Baileys
- **Port C#**: `/workspace/wwweb-csharp`

---

## Política de Merge com Upstream

### Regra principal: o fork deve ser IDÊNTICO ao upstream + traces

O `git diff upstream/master` deste fork deve conter **exclusivamente**:

1. `import { trace } from './trace-logger'` (ou path equivalente)
2. Chamadas `trace(...)` inseridas nas funções
3. **Mudanças estritamente necessárias** para inserir traces:
   - Variáveis intermediárias antes de `return` (para logar o valor retornado)
   - Blocos `{}` em early-returns de uma linha (para inserir trace antes do return)
   - Type assertions (`as Buffer`) quando o TS exigir para compilar com a refatoração
   - Contadores (`frameCount++`) usados exclusivamente em traces

**PROIBIDO** qualquer outra alteração, incluindo:
- Mudar formatação/indentação do código upstream
- Mudar destructuring (ex: multi-line → single-line)
- Adicionar type annotations que o upstream não tem
- Renomear variáveis ou funções
- Mudar `sock.method()` para `method()` via destructuring adicional
- Qualquer "melhoria" ou "correção" que o upstream não tenha

**Na dúvida**: se a mudança não é um `trace()` call nem é estritamente necessária para inserir um, ela NÃO deve existir.

### Como fazer merge com upstream

```bash
git fetch upstream
git merge upstream/master -m "Sync upstream: <resumo das mudanças>"

# Resolver conflitos:
# - Em imports: manter AMBOS (upstream + trace import)
# - Em lógica: SEMPRE usar a versão upstream, sem exceção
# - Em trace() calls: RE-ADICIONAR nos locais corretos da nova lógica
# - Se upstream adicionou funções novas: ADICIONAR traces nelas
```

### Checklist pós-merge

1. Verificar que todos os `import { trace }` foram preservados
2. Verificar que funções novas do upstream receberam traces
3. Rodar `npx tsc --noEmit` para confirmar zero erros
4. Se funções mudaram de nome/assinatura, atualizar os trace points
5. **Rodar `git diff upstream/master` e revisar**: toda linha `-`/`+` que não seja trace é um bug
6. **Sincronizar traces com o port C#**: todo trace novo no fork deve ser adicionado ao C# correspondente (e vice-versa)

---

## Instrumentação de Trace

### Arquivos de Instrumentação

| Arquivo | Propósito |
|---------|-----------|
| `src/Utils/trace-logger.ts` | Logger centralizado - escreve para `/tmp/baileys_trace.log` |
| `trace_session.ts` | Script de entrada para executar com trace habilitado |

### Cobertura

- **62 arquivos** instrumentados com **~1.250 trace calls**
- Todos os módulos: Socket, Utils, Signal, WABinary, WAUSync, WAM

### Módulos e Nomes de Trace

Os nomes de módulo são **idênticos aos do port C#** para comparação direta:

| Módulo | Arquivo(s) | C# Correspondente |
|--------|-----------|-------------------|
| `socket` | `Socket/socket.ts` | `Connection/WhatsAppClient.cs` |
| `noise-handler` | `Utils/noise-handler.ts` | `Crypto/NoiseHandler.cs` |
| `crypto` | `Utils/crypto.ts` | `Crypto/SignalKeys.cs` + helpers |
| `signal` | `Utils/signal.ts` | `Crypto/SignalKeys.cs` |
| `validate-connection` | `Utils/validate-connection.ts` | `Connection/WhatsAppClient.cs` |
| `wa-binary-decode` | `WABinary/decode.ts` | `Protocol/WABinaryReader.cs` |
| `wa-binary-encode` | `WABinary/encode.ts` | `Protocol/WABinaryWriter.cs` |
| `messages-send` | `Socket/messages-send.ts` | *(não portado ainda)* |
| `messages-recv` | `Socket/messages-recv.ts` | *(não portado ainda)* |
| `chats` | `Socket/chats.ts` | *(não portado ainda)* |
| `libsignal` | `Signal/libsignal.ts` | *(não portado ainda)* |

### Como Executar

```bash
# Modo QR Code
npx tsx trace_session.ts

# Modo Pairing Code
npx tsx trace_session.ts --use-pairing-code --phone 5511999999999

# Os logs ficam em:
# /tmp/baileys_trace.log  (trace detalhado)
# /tmp/baileys_pino.log   (pino logger do Baileys)
```

### Formato do Log

```
[HH:mm:ss.SSS] #SEQ +ELAPSEDms [MODULE] function:point { key: value, ... }
```

Formato idêntico ao `TraceLogger.cs` do port C# (`/tmp/csharp_trace.log`).

---

## Regras para Manutenção dos Traces

### Ao fazer merge com upstream

1. Se upstream **adicionou funções novas**: criar traces para elas
2. Se upstream **removeu funções**: remover os traces correspondentes
3. Se upstream **renomeou funções**: atualizar o nome no trace
4. Se upstream **mudou a assinatura**: atualizar os args logados no trace
5. **NUNCA** remover o import do `trace-logger` de nenhum arquivo

### Sincronização bidirecional com C#

Os traces deste fork e do port C# devem estar **sempre em sincronia** para que a comparação por `grep` funcione:

- **Mesmo módulo**: `trace('noise-handler', ...)` aqui → `TraceLogger.Trace("noise-handler", ...)` no C#
- **Mesmo nome de trace point**: `'encrypt:enter'` aqui → `"encrypt:enter"` no C#
- **Mesma convenção**: `function:enter`, `function:return`, `function:error`

**Ao adicionar/modificar traces no fork**:
1. Adicionar/modificar o trace correspondente no port C#
2. Se a função não existe no C# ainda, documentar no commit que o trace existe mas a função não foi portada

**Ao adicionar/modificar traces no C#**:
1. Verificar que o trace correspondente existe no fork
2. Se não existe, adicionar ao fork

### Ao adicionar traces novos

- Usar o mesmo nome de módulo que o C# usa (ou usará quando for portado)
- Para funções de crypto: **NUNCA** logar bytes de chaves, apenas `.length`
- Para BinaryNode: logar `tag`, `attrs`, nunca binary content
- Para JIDs: logar normalmente (necessário para entender o fluxo)
- Manter o padrão `function:enter` / `function:return` / `function:error`

### Padrão de trace call

```typescript
trace('module-name', 'functionName:enter', { arg1: val1, bufferArg: buf.length })
// ... lógica ...
trace('module-name', 'functionName:return', { resultSummary })
```

---

## Testando Pairing Code

**IMPORTANTE:** Antes de executar testes de pareamento, **sempre perguntar ao usuário** se pode executar, pois ele precisa estar com o celular disponível para inserir o código.

- Rate limiting é agressivo (erro 429) - esperar 5-10 min entre tentativas
- O código expira rapidamente
- Auth state é salvo em `trace_auth_info/` - deletar para fresh start

---

## Estratégia de Branch

Branch única: **`master`**. Contém o código upstream + instrumentação de trace.

Ao sincronizar com upstream:

```bash
git fetch upstream
git merge upstream/master -m "Sync upstream: <resumo das mudanças do upstream>"
# Resolver conflitos preservando traces
# Instrumentar funções novas do upstream
npx tsc --noEmit  # confirmar zero erros
```

A lógica upstream **sempre prevalece**. Traces são a única adição deste fork.
