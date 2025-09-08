# Use Node.js base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Install dependencies
RUN npm install

# Build the extension
RUN npm run package

# Set default command
CMD ["npm", "run", "watch"]