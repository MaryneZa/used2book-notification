const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const amqp = require("amqplib");

const server = http.createServer();
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        credentials: true,
        methods: ["GET", "POST"],
    },
});

// MongoDB Connection
const mongoURI = "mongodb://noti_user:noti_password@localhost:27018/notification_db?authSource=admin";
mongoose.connect(mongoURI)
    .then(() => console.log("MongoDB connected successfully !!"))
    .catch(err => console.error("MongoDB connection error:", err));

// Notification Schema
const notificationSchema = new mongoose.Schema({
    user_id: Number,

    //  payment
    buyer_id: data.buyer_id,
    listing_id: data.listing_id,
    seller_id: data.seller_id,

    type: String,
    message: String,
    related_id: String,
    chatId: String,
    read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});
const Notification = mongoose.model("Notification", notificationSchema);

// Helper function to get unique chat count
async function getUnreadChatCount(userId) {
    const unreadChats = await Notification.aggregate([
        { $match: { user_id: Number(userId), type: "chat", read: false } },
        { $group: { _id: "$chatId" } },
        { $count: "uniqueChats" }
    ]);
    console.log("unreadChats:", unreadChats);
    console.log("unreadChats.length:", unreadChats.length);
    return unreadChats.length > 0 ? unreadChats[0].uniqueChats : 0;
}

// Socket.IO Connection
io.on("connection", (socket) => {
    const userId = socket.handshake.query.user_id;
    socket.join(`user_${userId}`);
    console.log(`User ${userId} connected`);

    socket.on("get_unread_counts", async () => {
        const chatCount = await getUnreadChatCount(userId);
        const commentCount = await Notification.countDocuments({ user_id: userId, type: "comment", read: false });
        socket.emit("unread_counts", { chat: chatCount, comments: commentCount });
    });

    socket.on("chatRead", async ({ userId, chatId }) => {
        console.log("Chat read event received:", { userId, chatId });
        try {
            const result = await Notification.updateMany(
                { user_id: Number(userId), chatId, type: "chat", read: false },
                { $set: { read: true } }
            );
            console.log("Chat read update result:", result);
            const chatCount = await getUnreadChatCount(userId);
            const commentCount = await Notification.countDocuments({ user_id: Number(userId), type: "comment", read: false });
            console.log(`Emitting unread_counts to user_${userId}: chat=${chatCount}, comments=${commentCount}`);
            io.to(`user_${userId}`).emit("unread_counts", { chat: chatCount, comments: commentCount });
        } catch (err) {
            console.error("Error in chatRead handler:", err);
        }
    });

    socket.on("disconnect", () => console.log(`User ${userId} disconnected`));
});

// Consume from RabbitMQ
amqp.connect("amqp://guest:guest@localhost:5672").then(function (conn) {
    return conn.createChannel().then(function (ch) {
        ch.assertQueue("comment_queue").then(function () {
            ch.consume("comment_queue", async function (msg) {
                if (msg !== null) {
                    const data = JSON.parse(msg.content.toString());
                    const noti = new Notification(data);
                    await noti.save();
                    io.to(`user_${data.user_id}`).emit(data.type, { ...data, id: noti._id.toString() });
                    const chatCount = await getUnreadChatCount(data.user_id);
                    const commentCount = await Notification.countDocuments({ user_id: data.user_id, type: "comment", read: false });
                    io.to(`user_${data.user_id}`).emit("unread_counts", { chat: chatCount, comments: commentCount });
                    ch.ack(msg);
                }
            });
        });

        ch.assertQueue("chat_queue").then(function () {
            ch.consume("chat_queue", async function (msg) {
                if (msg !== null) {
                    const data = JSON.parse(msg.content.toString());
                    const noti = new Notification(data);
                    await noti.save();
                    io.to(data.chatId).emit("receiveMessage", { ...data, id: noti._id.toString() });
                    io.to(`user_${data.user_id}`).emit(data.type, { ...data, id: noti._id.toString() });
                    const chatCount = await getUnreadChatCount(data.user_id);
                    const commentCount = await Notification.countDocuments({ user_id: data.user_id, type: "comment", read: false });
                    io.to(`user_${data.user_id}`).emit("unread_counts", { chat: chatCount, comments: commentCount });
                    ch.ack(msg);
                }
            });
        });

        // notification-service.js
        ch.assertQueue("payment_queue").then(function () {
            ch.consume("payment_queue", async function (msg) {
                if (msg !== null) {
                    const data = JSON.parse(msg.content.toString());
                    console.log("Consumed from payment_queue:", data);
                    const noti_seller = new Notification({
                        user_id: data.seller_id,
                        buyer_id: data.buyer_id,
                        listing_id: data.listing_id,
                        seller_id: data.seller_id,
                        type: data.type,
                        message: data.message,
                        related_id: data.related_id,
                        read: false,
                        created_at: data.created_at,
                    });
                    await noti_seller.save();

                    const noti_buyer = new Notification({
                        user_id: data.buyer_id,
                        buyer_id: data.buyer_id,
                        listing_id: data.listing_id,
                        seller_id: data.seller_id,
                        type: data.type,
                        message: data.message,
                        related_id: data.related_id,
                        read: false,
                        created_at: data.created_at,
                    });
                    await noti_buyer.save();

                    // Emit to seller
                    io.to(`user_${data.seller_id}`).emit("payment_success", {
                        id: noti_seller._id.toString(),
                        message: data.message,
                        related_id: data.related_id,
                    });

                    // Emit to buyer
                    io.to(`user_${data.buyer_id}`).emit("payment_success", {
                        id: noti_buyer._id.toString(),
                        message: data.message,
                        related_id: data.related_id,
                    });

                    // Update unread payment count
                    const paymentCountSeller = await Notification.countDocuments({ user_id: data.seller_id, type: "payment_success", read: false });
                    io.to(`user_${data.seller_id}`).emit("unread_payment_count", { payments: paymentCountSeller });

                    const paymentCountBuyer = await Notification.countDocuments({ user_id: data.buyer_id, type: "payment_success", read: false });
                    io.to(`user_${data.buyer_id}`).emit("unread_payment_count", { payments: paymentCountBuyer });

                    const notiListSeller = await Notification.find({
                        user_id: data.seller_id,
                        type: "payment_success"
                    }).sort({ created_at: -1 }).lean();
                    
                    const notiListBuyer = await Notification.find({
                        user_id: data.buyer_id,
                        type: "payment_success"
                    }).sort({ created_at: -1 }).lean();
                    
                    io.to(`user_${data.seller_id}`).emit("payment_list", notiListSeller);

                    io.to(`user_${data.buyer_id}`).emit("payment_list", notiListBuyer);


                    ch.ack(msg);
                }
            });
        });

    });
}).catch(err => console.error("RabbitMQ connection error:", err));

// HTTP Endpoints
server.on("request", async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (url.pathname === "/notifications/unread" && req.method === "GET") {
        try {
            const userId = url.searchParams.get("user_id");
            const chatCount = await getUnreadChatCount(userId);
            console.log("chatCount:", chatCount);
            const commentCount = await Notification.countDocuments({ user_id: userId, type: "comment", read: false });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ chat: chatCount, comments: commentCount }));
        } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    }

    if (url.pathname === "/notifications/mark-read" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const { user_id, id } = JSON.parse(body);
                const noti = await Notification.findOneAndUpdate(
                    { _id: id, user_id, read: false },
                    { $set: { read: true } },
                    { new: true }
                );
                if (noti) {
                    const chatCount = await getUnreadChatCount(user_id);
                    const commentCount = await Notification.countDocuments({ user_id, type: "comment", read: false });
                    io.to(`user_${user_id}`).emit("unread_counts", { chat: chatCount, comments: commentCount });
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: "Notification not found or already read" }));
                }
            } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "Internal server error" }));
            }
        });
    }

    if (url.pathname === "/notifications/mark-chat-read" && req.method === "POST") {
        let body = "";
        req.setTimeout(5000, () => {
            res.statusCode = 408;
            res.end(JSON.stringify({ error: "Request timed out" }));
        });
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            console.log("Received mark-chat-read request:", body);
            try {
                const { user_id, chatId } = JSON.parse(body);
                console.log(`Updating notifications for user_id: ${user_id}, chatId: ${chatId}`);
                const result = await Notification.updateMany(
                    { user_id: Number(user_id), chatId, type: "chat", read: false },
                    { $set: { read: true } }
                );
                console.log("Update result:", result);
                const chatCount = await getUnreadChatCount(user_id);
                const commentCount = await Notification.countDocuments({ user_id: Number(user_id), type: "comment", read: false });
                console.log(`Emitting unread_counts to user_${user_id}: chat=${chatCount}, comments=${commentCount}`);
                io.to(`user_${user_id}`).emit("unread_counts", { chat: chatCount, comments: commentCount });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ success: true, modifiedCount: result.modifiedCount }));
            } catch (err) {
                console.error("Error in mark-chat-read:", err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "Internal server error" }));
            }
        });
    }

    if (url.pathname === "/notifications/unread-details" && req.method === "GET") {
        try {
            const userId = url.searchParams.get("user_id");
            const unreadNotis = await Notification.find({ user_id: Number(userId), type: "chat", read: false }).select("chatId type -_id");
            console.log("unreadNotis:", unreadNotis);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(unreadNotis));
        } catch (err) {
            console.error("Error in unread-details:", err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    }

    if (url.pathname === "/notifications/unread-payments" && req.method === "GET") {
        try {
            const userId = url.searchParams.get("user_id");
            const paymentCount = await Notification.countDocuments({ user_id: userId, type: "payment_success", read: false });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ payments: paymentCount }));
        } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    }
});

server.listen(5001, () => console.log("Notification Service running on port 5001"));


