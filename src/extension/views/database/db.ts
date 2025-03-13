import { Pool } from "pg";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Create a PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for AWS RDS if SSL is enforced
  },
});

// Test the connection
pool.connect()
  .then(client => {
    console.log("🚀 Connected to AWS PostgreSQL!");
    client.release(); // Release the client back to the pool
  })
  .catch(err => console.error("❌ Database connection error:", err.stack));

// Export query function
export const query = (text: string, params?: any[]) => pool.query(text, params);

