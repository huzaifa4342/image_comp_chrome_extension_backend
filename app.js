const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const sharp = require("sharp");
const { Pool } = require("pg");
var cors = require('cors')


const corsOptions ={
  origin:'*',
  credentials:true,            //access-control-allow-credentials:true
  optionSuccessStatus:200,
}

// const anthropic = require('anthropic');
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic(apiKey=process.env.ANTHROPIC_API_KEY);
const app = express();
app.use(cors(corsOptions)) // Use this after the variable declaration
app.use(bodyParser.json()); // for parsing application/json

// console.log("process.env", process.env);


// Database connection setup
const pool = new Pool({
  user: process.env.USER_NAME,
  host: process.env.HOST,
  database: process.env.DATABASE,
  password: process.env.PASSWORD,
  port: process.env.DB_PORT,
});

function databaseConnection() {
  return pool.connect();
}

function cleanAndParseJson(rawData) {
    try {
        // Remove unwanted newline characters and escape sequences
        let cleanedData = rawData
            .replace(/\\n/g, ' ')  // Replace newline escape sequences with a space
            .replace(/\\\"/g, '\"')  // Fix escape sequences for double quotes
            .replace(/\\'/g, '\'');  // Fix escape sequences for single quotes

        // Parse the cleaned data as JSON
        const parsedData = JSON.parse(cleanedData);
        return parsedData;
    } catch (error) {
        console.error("Error parsing JSON:", error);
        return null;
    }
}

// Fetch and convert image to JPEG format
async function fetchAndConvertImageToJpeg(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(response.data);
    const jpegBuffer = await sharp(imageBuffer).jpeg().toBuffer();
    return jpegBuffer.toString("base64");
  } catch (error) {
    throw new Error(
      `Failed to process the image at ${imageUrl}: ${error.message}`
    );
  }
}

app.post("/send_data", async (req, res) => {
  try {
    const { image1, image2 } = req.body;
    if (!image1 || !image2) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: image1 and image2",
      });
    }

    const client = await databaseConnection();
    const image1Like = `%${image1}%`;
    const image2Like = `%${image2}%`;

    // Check if data exists in the database
    const result = await client.query(
      "SELECT * FROM image_differences WHERE image1_url LIKE $1 AND image2_url LIKE $2",
      [image1Like, image2Like]
    );

    if (result.rows.length > 0) {
      const rawData = result.rows[0].description;
      const parsedData = cleanAndParseJson(rawData);
      console.log(parsedData)
      return res
        .status(201)
        .json({ status: "success", message: parsedData });
    }

    // Fetch and convert images to base64 JPEG
    const image1Data = await fetchAndConvertImageToJpeg(image1);
    const image2Data = await fetchAndConvertImageToJpeg(image2);

    const prompt = `
      Analyze the given two images and describe their differences:
      Provide the result in JSON format with this structure it should not be string instead of pure JSON formate strictly follow the instruction:
      {
        "differences": [
          {
            "content": "[Common content in both images]",
            "key_differences": [
              "[First difference]",
              "[Second difference]",
              "[Third difference]"
            ]
          }
        ]
      }
    `;

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      temperature: 0,
      system: "Respond only with short poems.",
      messages : [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": image1Data,
                    },
                },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": image2Data,
                    },
                },
                {
                    "type": "text",
                    "text": prompt
                }
            ],
        }
    ],
    });
    
    const parsedData = cleanAndParseJson(message.content[0].text)
    //   Save the result into the database
    await client.query(
      "INSERT INTO image_differences (image1_url, image2_url, description) VALUES ($1, $2, $3)",
      [image1, image2, JSON.stringify(parsedData)]
    );

    return res.status(201).json({ status: "success", message: parsedData});
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ status: "error", message: `Error occurred: ${error.message}` });
  }
});

// Server setup
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
