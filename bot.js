import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { Client, GatewayIntentBits, ActivityType } from "discord.js";
import keepAlive from "./server.js";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: "1",
    strict: true,
    deprecationErrors: true,
  },
  ssl: true,
  tls: true,
  minPoolSize: 1,
  maxPoolSize: 10,
});
let db, responses;

// Normalize text to handle different quote types and apostrophes
function normalizeText(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'") // Smart single quotes
    .replace(/[\u201C\u201D]/g, '"') // Smart double quotes
    .replace(/\u2013|\u2014/g, "--") // Em and en dashes
    .trim();
}

// Extract quoted strings, handling both smart and regular quotes
function extractQuotedStrings(text) {
  const quotesRegex = /["'""]([^"'""]+)["'""]/g;
  const matches = [...text.matchAll(quotesRegex)];
  return matches.map((m) => normalizeText(m[1]));
}

async function connectDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db("discordbot");
    responses = db.collection("responses");
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

async function addResponse(message, trigger) {
  const existing = await responses.findOne({ trigger: trigger.toLowerCase() });
  if (existing) throw new Error("Trigger already exists");

  let response, type;

  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    type = attachment.contentType?.startsWith("image/") ? "image" : "file";
    response = attachment.url;
  } else {
    const quoted = extractQuotedStrings(message.content);
    if (quoted.length !== 2) throw new Error("Invalid format");
    response = quoted[1];
    type = "text";
  }

  await responses.insertOne({
    trigger: trigger.toLowerCase(),
    response,
    type,
    createdAt: new Date(),
  });

  return `Added: "${trigger}" → ${type}`;
}

async function removeResponse(trigger) {
  const result = await responses.deleteOne({ trigger: trigger.toLowerCase() });
  if (result.deletedCount === 0) throw new Error("Trigger not found");
  return `Removed: "${trigger}"`;
}

async function editResponse(message, trigger) {
  const existing = await responses.findOne({ trigger: trigger.toLowerCase() });
  if (!existing) throw new Error("Trigger not found");

  let response, type;

  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    type = attachment.contentType?.startsWith("image/") ? "image" : "file";
    response = attachment.url;
  } else {
    const quoted = extractQuotedStrings(message.content);
    if (quoted.length !== 2) throw new Error("Invalid format");
    response = quoted[1];
    type = "text";
  }

  await responses.updateOne(
    { trigger: trigger.toLowerCase() },
    { $set: { response, type, updatedAt: new Date() } }
  );

  return `Updated: "${trigger}" → ${type}`;
}

async function checkMessages(content) {
  content = content.toLowerCase();
  const allResponses = await responses.find().toArray();
  return allResponses.filter((doc) => content.includes(doc.trigger));
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = normalizeText(message.content);
  console.log("Received message:", content);

  try {
    if (content.startsWith("--help")) {
      await message.channel.send(
        `Commands available:\n**1. --add "message" "response"**Adds a new message and its response.\n**2. --remove "message"**Removes a message and its response.\n**3. --edit "message" "new_response"**Edits the response of an existing message.\n**4. --list**List all registered responses.\n**5. --help**Displays this help message.`
      );
      return;
    }

    if (content.startsWith("--list")) {
      const allResponses = await responses.find().toArray();
      const list = allResponses
        .map(({ trigger, type }) => `- "${trigger}" (${type})`)
        .join("\n");
      await message.channel.send(`Responses:\n${list}`);
      return;
    }

    if (content.startsWith("--add")) {
      const trigger = extractQuotedStrings(content)[0];
      if (!trigger) throw new Error("Invalid format");
      const result = await addResponse(message, trigger);
      await message.channel.send(result);
      return;
    }

    if (content.startsWith("--remove")) {
      const trigger = extractQuotedStrings(content)[0];
      if (!trigger) throw new Error("Invalid format");
      const result = await removeResponse(trigger);
      await message.channel.send(result);
      return;
    }

    if (content.startsWith("--edit")) {
      const trigger = extractQuotedStrings(content)[0];
      if (!trigger) throw new Error("Invalid format");
      const result = await editResponse(message, trigger);
      await message.channel.send(result);
      return;
    }

    const matches = await checkMessages(content);
    for (const match of matches) {
      try {
        switch (match.type) {
          case "image":
          case "file":
            await message.channel.send({ files: [match.response] });
            break;
          case "text":
            await message.channel.send(match.response);
            break;
        }
      } catch (err) {
        console.error(`Failed to send response for "${match.trigger}":`, err);
      }
    }
  } catch (err) {
    await message.channel.send(`Error: ${err.message}`);
  }
});

client.on("ready", async () => {
  console.log("Bot is online!");
  await connectDB();

  client.user.setPresence({
    activities: [{ name: "Listening for --help", type: ActivityType.Custom }],
    status: "online",
  });
});

keepAlive();
client.login(process.env.DISCORD_TOKEN);
