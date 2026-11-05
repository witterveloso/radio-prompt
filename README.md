# Rádio Prompt

Rádio web 24 horas com toda a programação musical criada por inteligência artificial.
Roda 100% no GitHub Pages, sem servidor e sem mensalidade.

## Como funciona

Não existe um servidor transmitindo áudio. Cada ouvinte baixa a grade e calcula, pelo relógio,
qual música está no ar e em que segundo. Como todo mundo faz a mesma conta, todo mundo escuta
a mesma faixa ao mesmo tempo, como numa rádio de verdade.

- `index.html`: o player público (ao vivo, prompt da música no ar, a seguir, grade do dia)
- `admin.html`: o Estúdio, onde você cadastra músicas, vinhetas, grade e publica
- `data/`: musicas.json, vinhetas.json, grade.json, config.json
- `audio/`: os arquivos MP3
- `assets/motor.js`: o motor de programação (usado pelo player e pelo Estúdio)

A ordem das músicas muda todo dia, sem repetir a mesma faixa duas vezes seguidas.
Vinheta de identificação a cada N músicas e vinheta de abertura quando muda o bloco.

## Colocar no ar (primeira vez, sem terminal)

1. Entre em github.com, clique em **New repository**.
   Nome: `radio-prompt`. Público. Marque **Add a README file**. Crie.
2. No repositório, clique em **Add file > Upload files**.
   Abra a pasta `radio-prompt` no seu computador, selecione **tudo que está dentro dela**
   (inclusive as pastas) e arraste para a página. Clique em **Commit changes**.
3. Vá em **Settings > Pages**. Em *Source*, escolha **Deploy from a branch**,
   branch **main**, pasta **/ (root)**. Salve.
4. Em 1 a 2 minutos a rádio estará em `https://SEU-USUARIO.github.io/radio-prompt/`.
   O Estúdio fica em `https://SEU-USUARIO.github.io/radio-prompt/admin.html`.

## Criar o token para o Estúdio publicar

1. GitHub > foto de perfil > **Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**.
2. Repository access: **Only select repositories** > `radio-prompt`.
3. Permissions > Repository permissions > **Contents: Read and write**.
4. Copie o token e cole na aba **Publicar** do Estúdio. Ele fica salvo só no seu navegador.

Sem o token, qualquer pessoa pode abrir o admin.html, mas ninguém consegue alterar a rádio.

## Rotina de produção

1. Gere as músicas na IA (Suno, Udio etc.) e baixe em MP3.
2. No Estúdio, arraste os MP3 na aba **Músicas**. A duração é lida sozinha.
3. Em **Editar**, preencha gênero, artista (a persona de IA) e o **prompt** que você usou.
   O prompt aparece para o ouvinte enquanto a música toca.
4. Na aba **Grade**, defina os blocos e os gêneros de cada um. Os alertas avisam se faltar música.
5. Confira no **Simulador** o que vai tocar em qualquer dia e horário.
6. Clique em **Publicar**. A rádio atualiza em 1 a 2 minutos; quem já está ouvindo recebe
   a nova grade em até 10 minutos, na troca de faixa.

As 8 faixas que vieram junto são **demonstrações sintetizadas por código**, só para a rádio
nascer funcionando. Exclua todas quando subir as suas.

## Quanto conteúdo precisa

Com músicas de 3 minutos, um bloco de 4 horas toca cerca de 80 faixas. Para não repetir
demais, mire em pelo menos 30 faixas por gênero. Um acervo de 150 a 200 faixas já deixa a
rádio com cara de rádio. O Simulador mostra a "maior repetição de uma faixa" no dia.

## Limites do GitHub Pages (importante)

- Cada arquivo até 100 MB (pelo upload do site, até 25 MB). MP3 de 3 a 4 minutos tem cerca de 5 MB.
- Site publicado até cerca de 1 GB, ou seja, por volta de 180 músicas em 128 kbps.
- Tráfego recomendado de até 100 GB por mês. Um ouvinte consome cerca de 58 MB por hora,
  então isso dá em torno de 1.700 horas de audição por mês.

Quando a audiência crescer, o caminho é mover os MP3 para um armazenamento com tráfego
barato (Cloudflare R2, por exemplo) e manter o site no GitHub. O campo `arquivo` em
`musicas.json` já aceita um endereço completo (`https://...`).

## Direitos das músicas

Para tocar publicamente músicas geradas por IA, use um plano que libere uso comercial na
ferramenta que gerou a faixa (no Suno, por exemplo, isso vale para os planos pagos).
Confira os termos atuais de cada ferramenta antes de publicar.
