# Use official Node.js 18 alpine image for small size and stability
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm install --production

# Copy all source files
COPY . .

# Expose port 8080 for WebSocket server
EXPOSE 8080

# Start the server
CMD ["npm", "start"]
