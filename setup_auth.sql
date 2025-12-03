-- Setup script for CloudPrepper Admin Authentication
-- This creates the users table and sets up the first admin account

-- Create the users table if it doesn't exist
CREATE TABLE IF NOT EXISTS prepper.users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON prepper.users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON prepper.users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON prepper.users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON prepper.users(is_active);

-- Add update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_updated_at') THEN
        CREATE TRIGGER update_users_updated_at 
            BEFORE UPDATE ON prepper.users 
            FOR EACH ROW 
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Insert a default admin user (password: admin123)
-- Note: Password is 'admin123' - CHANGE THIS IMMEDIATELY after first login!
INSERT INTO prepper.users (username, email, password_hash, role)
VALUES ('admin', 'admin@comptiaprepper.com', '$2b$10$8K6Oy3YgHVr4rK9wjNZOjOQK3RJf9QXcj5YvHfCy8m2XdCa1E4N8K', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Verify the setup
SELECT 
    'Users table setup completed' as status,
    COUNT(*) as total_users,
    COUNT(CASE WHEN role = 'admin' THEN 1 END) as admin_users
FROM prepper.users;

-- Display admin login info
SELECT 
    'Admin Login Credentials:' as info,
    'Email: admin@comptiaprepper.com' as email,
    'Password: admin123' as password,
    'IMPORTANT: Change password immediately after login!' as warning;
