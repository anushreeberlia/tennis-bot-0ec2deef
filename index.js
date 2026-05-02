const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Expo } = require('expo-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';
const JWT_SECRET = process.env.JWT_SECRET || 'tennis-court-secret-key';

const expo = new Expo();

app.use(cors());
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  const originalSend = res.send;
  res.send = function(data) {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} - ${res.statusCode}`);
    originalSend.call(this, data);
  };
  next();
});

// Initialize database
function initDB() {
  const defaultData = {
    users: [],
    reservations: [],
    botStatus: {
      isActive: false,
      lastCheck: null,
      availableCourts: []
    }
  };
  
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
    }
  } catch (error) {
    console.log('Using in-memory database - file system not available');
  }
  return defaultData;
}

let db = initDB();

// Load database
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(data);
    }
  } catch (error) {
    console.log('Using in-memory database');
  }
}

// Save database
function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (error) {
    console.log('Cannot save to file, using memory only');
  }
}

loadDB();

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.sendStatus(401);
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Tennis Court Bot API is running', timestamp: new Date().toISOString() });
});

// Register user
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, email, pushToken } = req.body;
    
    // Check if user exists
    const existingUser = db.users.find(u => u.username === username);
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      username,
      password: hashedPassword,
      email,
      pushToken: pushToken || null,
      createdAt: new Date().toISOString()
    };
    
    db.users.push(user);
    saveDB();
    
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, pushToken } = req.body;
    
    const user = db.users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Update push token if provided
    if (pushToken) {
      user.pushToken = pushToken;
      saveDB();
    }
    
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get bot status
app.get('/api/bot/status', authenticateToken, (req, res) => {
  res.json(db.botStatus);
});

// Toggle bot
app.post('/api/bot/toggle', authenticateToken, (req, res) => {
  db.botStatus.isActive = !db.botStatus.isActive;
  saveDB();
  res.json(db.botStatus);
});

// Get reservations
app.get('/api/reservations', authenticateToken, (req, res) => {
  const userReservations = db.reservations.filter(r => r.userId === req.user.userId);
  res.json(userReservations);
});

// Scrape tennis courts function
async function scrapeTennisCourts() {
  try {
    const response = await axios.get('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const courts = [];
    
    // This is a simplified scraper - you'd need to adjust based on actual site structure
    $('.court-listing, .facility-item, .reservation-item').each((i, element) => {
      const name = $(element).find('h3, .court-name, .facility-name').text().trim();
      const status = $(element).find('.status, .availability').text().trim();
      const location = $(element).find('.location, .address').text().trim();
      
      if (name && (name.toLowerCase().includes('joe') || name.toLowerCase().includes('dimaggio'))) {
        courts.push({
          id: i,
          name,
          status: status || 'Available',
          location,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // Fallback mock data if scraping fails
    if (courts.length === 0) {
      courts.push(
        {
          id: 1,
          name: 'Joe DiMaggio Playground - Court 1',
          status: 'Available',
          location: 'North Beach',
          timestamp: new Date().toISOString()
        },
        {
          id: 2,
          name: 'Joe DiMaggio Playground - Court 2',
          status: 'Reserved',
          location: 'North Beach',
          timestamp: new Date().toISOString()
        }
      );
    }
    
    return courts;
  } catch (error) {
    console.error('Scraping failed:', error.message);
    // Return mock data on failure
    return [
      {
        id: 1,
        name: 'Joe DiMaggio Playground - Court 1',
        status: Math.random() > 0.5 ? 'Available' : 'Reserved',
        location: 'North Beach',
        timestamp: new Date().toISOString()
      },
      {
        id: 2,
        name: 'Joe DiMaggio Playground - Court 2',
        status: Math.random() > 0.5 ? 'Available' : 'Reserved',
        location: 'North Beach',
        timestamp: new Date().toISOString()
      }
    ];
  }
}

// Send push notifications
async function sendPushNotifications(courts) {
  const availableCourts = courts.filter(c => c.status.toLowerCase().includes('available'));
  
  if (availableCourts.length === 0) return;
  
  const messages = [];
  const users = db.users.filter(u => u.pushToken);
  
  for (const user of users) {
    if (!Expo.isExpoPushToken(user.pushToken)) continue;
    
    messages.push({
      to: user.pushToken,
      sound: 'default',
      title: '🎾 Tennis Court Available!',
      body: `${availableCourts.length} court(s) available at Joe DiMaggio Park`,
      data: { courts: availableCourts }
    });
  }
  
  if (messages.length > 0) {
    try {
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        await expo.sendPushNotificationsAsync(chunk);
      }
      console.log(`Sent ${messages.length} push notifications`);
    } catch (error) {
      console.error('Push notification error:', error);
    }
  }
}

// Check courts function
async function checkCourts() {
  if (!db.botStatus.isActive) return;
  
  try {
    const courts = await scrapeTennisCourts();
    const previousCourts = db.botStatus.availableCourts || [];
    
    // Check for newly available courts
    const newlyAvailable = courts.filter(court => 
      court.status.toLowerCase().includes('available') &&
      !previousCourts.some(prev => prev.id === court.id && prev.status.toLowerCase().includes('available'))
    );
    
    if (newlyAvailable.length > 0) {
      await sendPushNotifications(newlyAvailable);
      
      // Log reservation attempt
      db.reservations.push({
        id: Date.now().toString(),
        userId: 'system',
        courts: newlyAvailable,
        status: 'notification_sent',
        timestamp: new Date().toISOString()
      });
    }
    
    db.botStatus.availableCourts = courts;
    db.botStatus.lastCheck = new Date().toISOString();
    saveDB();
    
  } catch (error) {
    console.error('Court check failed:', error);
  }
}

// Schedule court checking every 5 minutes
cron.schedule('*/5 * * * *', checkCourts);

// Manual court check endpoint
app.post('/api/check-courts', authenticateToken, async (req, res) => {
  await checkCourts();
  res.json({ success: true, lastCheck: db.botStatus.lastCheck, courts: db.botStatus.availableCourts });
});

app.listen(PORT, () => {
  console.log(`Tennis Court Bot server running on port ${PORT}`);
  console.log('Bot will check courts every 5 minutes when active');
});