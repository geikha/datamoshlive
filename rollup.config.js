export default {
  input: 'src/index.js',
  output: [
    {
      file:    'dist/datamoshlive.js',
      format:  'iife',
      name:    'DatamoshLive',
      exports: 'default',
    },
    {
      file:   'dist/datamoshlive.esm.js',
      format: 'esm',
    },
  ],
};
