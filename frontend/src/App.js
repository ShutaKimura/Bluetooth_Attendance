// import logo from './logo.svg';
import './App.css';
import Status from './Status';
// import Register from './Register';
import React from 'react';


function App() {
  return (
    <div className="App">
      <h1>在室管理システム</h1>
      <Status />
      {/* <Register /> */}
    </div>
    // <div className="App">
    //   <header className="App-header">
    //     <img src={logo} className="App-logo" alt="logo" />
    //     <p>
    //       Edit <code>src/App.js</code> and save to reload.
    //     </p>
    //     <a
    //       className="App-link"
    //       href="https://reactjs.org"
    //       target="_blank"
    //       rel="noopener noreferrer"
    //     >
    //       Learn React
    //     </a>
    //   </header>
    // </div>
  );
}

export default App;
