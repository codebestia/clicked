# Getting started with Clicked

Clicked is a private messaging app where your Stellar wallet is your login. There is no
password and no separate account to create. This guide takes you from nothing installed to
sending your first message, file and tokens.

You will need:

- A desktop browser such as Chrome, Brave, Edge or Firefox.
- A few minutes. You do not need to buy anything to get started.

---

## 1. Install Freighter

Freighter is a free browser extension that holds your Stellar wallet. Clicked uses it to
confirm that you are you.

1. Go to the Freighter website, [freighter.app](https://www.freighter.app), and choose the
   install button for your browser. You can also search for "Freighter" in your browser's
   extension store.
2. Add the extension, then pin it to your toolbar so it is easy to find (look for the puzzle
   piece icon in your browser).
3. Open Freighter and choose **Create new wallet**, or **Import wallet** if you already have one.
4. Write down your **recovery phrase** (a list of 12 or 24 words) on paper and keep it
   somewhere safe and private.

> **Keep your recovery phrase secret.** Anyone who has it can take everything in your wallet.
> Clicked and Freighter will never ask you to type it into a website or send it in a message.
> If anyone asks for it, even someone claiming to be support, it is a scam.

## 2. Connect your wallet

1. Open Clicked in the same browser.
2. Select **Connect Wallet**.
3. Freighter opens a small window asking whether Clicked may see your wallet address.
   Choose **Approve** (or **Connect**).

Your wallet address is the long code beginning with `G`. It is public by design, a bit like
a username, and sharing it lets people find you. Connecting does not move any money.

## 3. Sign in

After connecting, Clicked asks you to sign in. Freighter opens again with a request to
**sign a message**.

**What the request means.** Clicked has made up a one-time piece of text and is asking your
wallet to put its signature on it. Only the owner of the wallet can produce that signature, so
it proves that you control the address without a password ever being sent anywhere.

**What it does not do:**

- It does **not** spend any money. No fee is charged.
- It does **not** give Clicked, or anyone else, permission to spend your funds, now or later.
- It does **not** send anything to the Stellar network. It is just a signature on a note.

Read the text in the Freighter window. If it looks like a payment or a transaction, with an
amount, a destination or a fee, **do not approve it**. A sign-in request is plain text.

Choose **Approve** or **Sign**. You are now signed in, and the first time on a new browser your
device is set up for private messaging automatically. This takes a moment.

> **Signing out.** Selecting your address at the bottom-left of the app disconnects your wallet.
> You can sign in again at any time with the same steps.

## 4. Start a conversation

**A direct conversation (one other person)**

1. Choose **New conversation**.
2. Type the other person's username into **Search users**.
3. Select their name (it says **Start DM**). The conversation opens and you can type straight away.

**A group conversation**

A group is a conversation with three or more people. Create one from **New conversation** by
choosing several people instead of one, give it a name, and select **Create**. Everyone in the
group can read new messages. People who join later cannot read what was sent before they joined.

> Group creation and some screens are still being rolled out, so what you see may differ a
> little from these steps. If you cannot find an option described here, check back after the
> next update.

### Check you're talking to the right person

At the top of every conversation is a **Safety numbers** button. Compare the number shown
there with the other person, ideally in person or by a phone call. If they match, select
**Mark verified**. If the number ever changes later, Clicked shows an amber **Safety number
changed** warning. This can be harmless (they got a new phone), but confirm with them another
way before sharing anything sensitive.

For more on this, see [Devices, safety numbers, and privacy](devices-and-privacy.md).

## 5. Send a message

Type in the box at the bottom of the conversation and press **Enter**, or select **Send**.
Messages are scrambled on your device and can only be opened by the people in the conversation.
Not even Clicked can read them.

## 6. Send a file

1. Select the **paperclip** icon next to the message box.
2. Choose a file from your computer. Photos and videos show a small preview in the chat.
3. The file is sent as soon as you choose it. Wait for the paperclip to become active again
   before sending another.

To open a file someone sent you, select its name or **Download**. It is unscrambled on your
device as it downloads.

## 7. Send tokens in a chat

You can send tokens (such as XLM) to the person you are talking to, and the payment appears as
a card in the conversation showing the amount, the token, and a **View on explorer** link where
anyone in the chat can check it went through.

1. In the conversation, choose the option to send tokens.
2. Enter the amount.
3. Freighter opens and shows the payment: who it goes to, how much, and the network fee.
   **Check these carefully.** This is the one step that really does spend money.
4. Choose **Approve** in Freighter.

Unlike signing in, approving a payment is permanent: a sent payment cannot be taken back. Start
with a small test amount for someone new. Make sure you have enough in your wallet to cover the
amount plus the small network fee.

---

## Troubleshooting

| What you see | What to try |
|---|---|
| Nothing happens when I choose **Connect Wallet** | Check that Freighter is installed, enabled for this site, and unlocked (enter your Freighter password). Then try again. |
| Freighter's window didn't open | Click the Freighter icon in your toolbar. A request may be waiting there. |
| "Unable to request sign-in challenge" or similar | Clicked could not be reached. Check your connection and try again in a minute. |
| I rejected the sign-in request by mistake | Nothing was lost. Select **Connect Wallet** again and approve it this time. |
| A message says it is unavailable or cannot be opened | It may have been sent before this device was set up. Ask the sender to send it again. |
| I changed computers or browsers | Install Freighter and import your recovery phrase, then sign in again. Older messages may not appear on a new device. |

More questions about privacy and your devices? Read
[Devices, safety numbers, and privacy](devices-and-privacy.md) and, for shared group funds,
[the treasury guide](treasury.md).
