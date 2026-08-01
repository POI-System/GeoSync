module.exports = {
    apps: [
        {
            name: 'poi',
            cwd: '/opt/poi',
            script: 'server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production'
            },
            env_production: {
                NODE_ENV: 'production'
            },
            merge_logs: true,
            error_file: '/opt/poi/logs/err.log',
            out_file:   '/opt/poi/logs/out.log',
            time: true
        }
    ]
};
